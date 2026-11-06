import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CaseError, CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { createRuntime } from '../src/runtime.ts';
import { IntakeLoop } from '../src/loops/engine.ts';
import { LoopRunStore } from '../src/loops/store.ts';
import type { LoopSource } from '../src/loops/contracts.ts';
import { createLoopExamplePlugins, EXAMPLE_LOOP_REFS, EXAMPLE_LOOP_TEXTS } from '../examples/loop-fixtures.ts';

const code = (expected: string) => (error: unknown) => error instanceof CaseError && error.code === expected;
const absent = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-loop-cancel-'));
  const cases = new CaseStore(directory);
  const workspace = new CaseWorkspace(directory, cases);
  const record = await cases.create({ title: '虚构保存取消测试案', actor: '测试用户' });
  const sources: LoopSource[] = [];
  for (const material of Object.values(EXAMPLE_LOOP_TEXTS)) {
    const saved = await workspace.registerText({ caseId: record.id, ...material });
    const view = await workspace.readVersion({ caseId: record.id, materialId: saved.id, versionId: saved.id });
    sources.push({ materialId: saved.id, versionId: view.version.id, textSha256: view.version.textSha256 });
  }
  const host = await createRuntime({ dataDir: directory, plugins: createLoopExamplePlugins('read-together') });
  t.after(async () => {
    await host.stop();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const run = await new IntakeLoop(host).run({
    caseId: record.id, goal: '仅核对保存取消边界，不执行模型调用', sources, ...EXAMPLE_LOOP_REFS,
  });
  assert.equal(run.status, 'completed');
  const before = await cases.readState(record.id);
  const stagedPath = join(cases.directory(record.id), 'loop-runs', `${run.id}.json`);
  return { directory, cases, record, run, before, stagedPath };
}

class AbortDuringReadStore extends CaseStore {
  readonly controller: AbortController;
  constructor(directory: string, controller: AbortController) { super(directory); this.controller = controller; }
  override async readState(caseId: string) {
    const result = await super.readState(caseId);
    this.controller.abort('test cancellation after asynchronous state read');
    return result;
  }
}

class AbortDuringCommitPreparationStore extends CaseStore {
  readonly controller: AbortController;
  #armed = false;
  constructor(directory: string, controller: AbortController) { super(directory); this.controller = controller; }
  override async commitWorkspace(
    input: Parameters<CaseStore['commitWorkspace']>[0], options: Parameters<CaseStore['commitWorkspace']>[1] = {},
  ) {
    this.#armed = true;
    return super.commitWorkspace(input, options);
  }
  override async history(caseId: string) {
    const result = await super.history(caseId);
    if (this.#armed) {
      this.#armed = false;
      this.controller.abort('test cancellation during journal preparation');
    }
    return result;
  }
}

test('a pre-aborted save publishes neither a run file nor a case revision', async (t) => {
  const data = await fixture(t);
  const controller = new AbortController();
  controller.abort('private cancellation detail');
  const runs = new LoopRunStore(data.directory, data.cases);
  await assert.rejects(runs.save(data.run, { signal: controller.signal }), code('LOOP_RUN_CANCELLED'));
  assert.deepEqual(await data.cases.readState(data.record.id), data.before);
  await assert.rejects(readFile(data.stagedPath), absent);
  await assert.rejects(runs.read({ caseId: data.record.id, runId: data.run.id }), code('LOOP_RUN_NOT_ACTIVE'));
});

test('cancellation during asynchronous save validation cannot advertise a result in the case view', async (t) => {
  const data = await fixture(t);
  const controller = new AbortController();
  const runs = new LoopRunStore(data.directory, new AbortDuringReadStore(data.directory, controller));
  await assert.rejects(runs.save(data.run, { signal: controller.signal }), code('LOOP_RUN_CANCELLED'));
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(await data.cases.readState(data.record.id), data.before);
  await assert.rejects(readFile(data.stagedPath), absent);
  await assert.rejects(runs.read({ caseId: data.record.id, runId: data.run.id }), code('LOOP_RUN_NOT_ACTIVE'));
});

test('cancellation while preparing the journal prevents atomic publication even after a run file was staged', async (t) => {
  const data = await fixture(t);
  const controller = new AbortController();
  const cancellingCases = new AbortDuringCommitPreparationStore(data.directory, controller);
  const runs = new LoopRunStore(data.directory, cancellingCases);
  const historyBefore = await data.cases.history(data.record.id);
  await assert.rejects(runs.save(data.run, { signal: controller.signal }), code('CASE_OPERATION_CANCELLED'));
  assert.equal(controller.signal.aborted, true);
  // The immutable file may exist, but only a committed case revision can make
  // it current. This asserts the test reached the late publication boundary.
  assert.equal(JSON.parse(await readFile(data.stagedPath, 'utf8')).id, data.run.id);
  assert.deepEqual(await data.cases.history(data.record.id), historyBefore);
  assert.deepEqual(await data.cases.readState(data.record.id), data.before);
  await assert.rejects(runs.read({ caseId: data.record.id, runId: data.run.id }), code('LOOP_RUN_NOT_ACTIVE'));
});

test('an active save signal commits once and the run remains readable after the store is reopened', async (t) => {
  const data = await fixture(t);
  const controller = new AbortController();
  const runs = new LoopRunStore(data.directory, data.cases);
  assert.deepEqual(await runs.save(data.run, { signal: controller.signal }), data.run);
  assert.equal(controller.signal.aborted, false);
  const after = await data.cases.readState(data.record.id);
  assert.equal(after.record.revision, data.before.record.revision + 1);
  assert.deepEqual(after.workspace?.loopRuns?.map((entry) => entry.runId), [data.run.id]);
  assert.deepEqual(await new LoopRunStore(data.directory).read({ caseId: data.record.id, runId: data.run.id }), data.run);
});
