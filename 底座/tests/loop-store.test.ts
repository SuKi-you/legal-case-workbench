import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { CaseRollback } from '../src/cases/rollback.ts';
import { LoopRunStore } from '../src/loops/store.ts';
import { loopRunSchema, type LoopRun } from '../src/loops/contracts.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-loop-store-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const cases = new CaseStore(dataDir);
  const workspace = new CaseWorkspace(dataDir, cases);
  const loops = new LoopRunStore(dataDir, cases);
  const rollback = new CaseRollback(cases, workspace);
  const record = await cases.create({ title: '虚构整理记录案', actor: '测试用户' });
  const material = await workspace.registerText({ caseId: record.id, sourceLabel: '原陈述', text: '🙂原记载金额8000元。' });
  const { version } = await workspace.readVersion({ caseId: record.id, materialId: material.id, versionId: material.id });
  const makeRun = async (): Promise<LoopRun> => {
    const current = await cases.read(record.id);
    const source = { materialId: material.id, versionId: version.id, textSha256: version.textSha256 };
    const now = new Date().toISOString();
    const needId = 'test.amount';
    const findingId = randomUUID();
    const start = version.text.indexOf('8000元');
    const request = { needId, instruction: '读取记载的金额', reason: '核对原陈述内容' };
    const provider = (id: string) => ({ capability: { id: `test.${id}`, version: 1 }, pluginId: `fixture.${id}`, pluginVersion: '1' });
    return loopRunSchema.parse({
      id: randomUUID(), caseId: record.id, baseCaseRevision: current.revision,
      goal: '核对金额陈述', createdAt: now, finishedAt: now, sources: [source],
      providers: { declare: provider('declare'), read: provider('read'), review: provider('review') },
      limits: { maxRounds: 4, maxReads: 12 }, needs: [{ id: needId, question: '材料写了多少金额？', reason: '供后续核对' }],
      findings: [{ id: findingId, needId, statement: '原陈述记载8000元。',
        citations: [{ ...source, start, end: start + 5, quote: '8000元' }] }],
      rounds: [{ number: 1, attempts: [{ request, examined: [source], findingIds: [findingId], note: '已读取' }],
        review: { assessments: [{ needId, status: 'satisfied', findingIds: [findingId], reason: '已找到陈述及出处' }], nextRequests: [] } }],
      status: 'completed', reason: '声明的信息需求已处理',
    });
  };
  return { dataDir, cases, workspace, loops, rollback, caseId: record.id, material, version, makeRun };
}
async function restore(rollback: CaseRollback, caseId: string, checkpointId: string) {
  const preview = await rollback.preview({ caseId, checkpointId });
  return rollback.apply({ caseId, checkpointId, expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '测试用户' });
}

test('loop runs save immutable case records, survive restart, and remain after ordinary material saves', async (t) => {
  const { dataDir, cases, workspace, loops, caseId, makeRun } = await fixture(t);
  const run = await makeRun();
  await loops.save(run);
  assert.deepEqual(await new LoopRunStore(dataDir).read({ caseId, runId: run.id }), run);
  assert.equal((await cases.read(caseId)).revision, run.baseCaseRevision + 1);
  await workspace.registerText({ caseId, sourceLabel: '补充', text: '普通材料保存保留整理记录。' });
  assert.deepEqual((await cases.readState(caseId)).workspace?.loopRuns?.map((entry) => entry.runId), [run.id]);
  assert.deepEqual(await loops.read({ caseId, runId: run.id }), run);
  assert.equal((await readdir(join(cases.directory(caseId), 'loop-runs'))).some((file) => file.endsWith('.tmp')), false);
  const duplicate = { ...run, baseCaseRevision: (await cases.read(caseId)).revision };
  await assert.rejects(loops.save(duplicate), /LOOP_RUN_EXISTS/);
});

test('whole-case rollback hides later loop runs and automatic undo restores their exact trace', async (t) => {
  const { dataDir, cases, workspace, loops, rollback, caseId, makeRun } = await fixture(t);
  const checkpoint = await rollback.createCheckpoint({ caseId, label: '整理之前', actor: '测试用户' });
  assert.equal(checkpoint.workspace.loopRuns, undefined);
  const run = await makeRun();
  await loops.save(run);
  const preview = await rollback.preview({ caseId, checkpointId: checkpoint.id });
  assert.deepEqual(preview.loopRunsLeaving, [run.id]);
  const rolled = await restore(rollback, caseId, checkpoint.id);
  await assert.rejects(loops.read({ caseId, runId: run.id }), /LOOP_RUN_NOT_ACTIVE/);
  assert.ok((await readFile(join(cases.directory(caseId), 'loop-runs', `${run.id}.json`), 'utf8')).includes(run.id));
  const restarted = new CaseRollback(new CaseStore(dataDir), new CaseWorkspace(dataDir));
  const undoPreview = await restarted.preview({ caseId, checkpointId: rolled.undoCheckpoint.id });
  assert.deepEqual(undoPreview.loopRunsReturning, [run.id]);
  await restore(restarted, caseId, rolled.undoCheckpoint.id);
  assert.deepEqual(await new LoopRunStore(dataDir).read({ caseId, runId: run.id }), run);
  await workspace.validateState(caseId, (await cases.readState(caseId)).workspace!);
});

test('profile changes, source revisions and rollbacks reject a loop started from an older case revision', async (t) => {
  const { cases, workspace, loops, rollback, caseId, material, version, makeRun } = await fixture(t);
  const beforeChange = await makeRun();
  await cases.update({ caseId, expectedRevision: beforeChange.baseCaseRevision, actor: '测试用户', stage: '资料更新' });
  await assert.rejects(loops.save(beforeChange), /LOOP_RUN_STALE/);
  const beforeRevision = await makeRun();
  await workspace.saveRevision({ caseId, materialId: material.id, baseVersionId: version.id,
    baseTextSha256: version.textSha256, text: '修订金额6000元', editor: '测试用户' });
  await assert.rejects(loops.save(beforeRevision), /LOOP_RUN_STALE/);
  const checkpoint = await rollback.createCheckpoint({ caseId, label: '回滚目标', actor: '测试用户' });
  const beforeRollback = await makeRun();
  await restore(rollback, caseId, checkpoint.id);
  await assert.rejects(loops.save(beforeRollback), /LOOP_RUN_STALE/);
  assert.deepEqual((await cases.readState(caseId)).workspace?.loopRuns ?? [], []);
});

test('a save racing after loop validation loses the final case CAS and cannot enter the current view', async (t) => {
  const { cases, workspace, loops, caseId, makeRun } = await fixture(t);
  const run = await makeRun();
  const commit = cases.commitWorkspace.bind(cases);
  let inserted = false;
  cases.commitWorkspace = async (input) => {
    if (!inserted && input.workspace.loopRuns?.some((entry) => entry.runId === run.id)) {
      inserted = true;
      await workspace.registerText({ caseId, sourceLabel: '并发补料', text: '模型完成后先保存的补料' });
    }
    return commit(input);
  };
  await assert.rejects(loops.save(run), /LOOP_RUN_STALE/);
  await assert.rejects(loops.read({ caseId, runId: run.id }), /LOOP_RUN_NOT_ACTIVE/);
  assert.equal((await workspace.contents(caseId)).materials.length, 2);
  assert.equal((await readdir(join(cases.directory(caseId), 'loop-runs'))).includes(`${run.id}.json`), true);
});

test('loop reads, saves and citations stay in the explicit case and selected source versions', async (t) => {
  const { cases, loops, caseId, makeRun } = await fixture(t);
  const run = await makeRun();
  const other = await cases.create({ title: '另一个虚构案', actor: '测试用户' });
  await loops.save(run);
  await assert.rejects(loops.read({ caseId: other.id, runId: run.id }), /LOOP_RUN_NOT_ACTIVE/);
  await assert.rejects(loops.save({ ...run, id: randomUUID(), caseId: other.id, baseCaseRevision: other.revision }), /LOOP_SOURCE_NOT_ACTIVE/);
  const wrongQuote = await makeRun();
  wrongQuote.findings[0]!.citations[0]!.quote = '6000元';
  await assert.rejects(loops.save(wrongQuote), /LOOP_CITATION_INVALID/);
  const splitEmoji = await makeRun();
  splitEmoji.findings[0]!.citations[0] = { ...splitEmoji.findings[0]!.citations[0]!, start: 1, end: 2, quote: '\ude42' };
  await assert.rejects(loops.save(splitEmoji));
  const foreignVersion = await makeRun();
  foreignVersion.sources[0]!.versionId = randomUUID();
  await assert.rejects(loops.save(foreignVersion), /LOOP_SOURCE_NOT_ACTIVE/);
  await assert.rejects(loops.read({ caseId: '../outside', runId: run.id }));
});

test('damaged loop files block reads and restoration without appending case or undo history', async (t) => {
  const { cases, loops, rollback, caseId, makeRun } = await fixture(t);
  const run = await makeRun();
  await loops.save(run);
  const checkpoint = await rollback.createCheckpoint({ caseId, label: '包含循环记录', actor: '测试用户' });
  const before = await cases.read(caseId);
  await writeFile(join(cases.directory(caseId), 'loop-runs', `${run.id}.json`), '{broken');
  await assert.rejects(loops.read({ caseId, runId: run.id }), /LOOP_RUN_CHANGED/);
  await assert.rejects(rollback.preview({ caseId, checkpointId: checkpoint.id }), /LOOP_RUN_CHANGED/);
  assert.equal((await cases.read(caseId)).revision, before.revision);
  assert.equal((await rollback.listCheckpoints(caseId)).length, 1);
});

test('loop manifest cannot remove, rewrite or duplicate records during ordinary saves', async (t) => {
  const { cases, loops, caseId, makeRun } = await fixture(t);
  const run = await makeRun();
  await loops.save(run);
  const before = await cases.readState(caseId);
  const entry = before.workspace!.loopRuns![0]!;
  for (const loopRuns of [[], [{ ...entry, sha256: '0'.repeat(64) }], [entry, entry]]) {
    await assert.rejects(cases.commitWorkspace({ caseId, expectedRevision: before.record.revision,
      workspace: { ...before.workspace!, loopRuns }, actor: '测试用户' }), /CASE_RECORD_INVALID/);
  }
  assert.equal((await cases.read(caseId)).revision, before.record.revision);
});

test('loop records cannot be restored with a target state that omits their selected source version', async (t) => {
  const { cases, loops, workspace, caseId, makeRun } = await fixture(t);
  const run = await makeRun();
  await loops.save(run);
  const state = (await cases.readState(caseId)).workspace!;
  const detached = structuredClone(state);
  detached.materials[0]!.versions = [];
  await assert.rejects(workspace.validateState(caseId, detached), /LOOP_SOURCE_NOT_ACTIVE/);
  const entry = state.loopRuns![0]!;
  const path = join(cases.directory(caseId), 'loop-runs', `${run.id}.json`);
  const content = JSON.parse(await readFile(path, 'utf8'));
  content.caseId = randomUUID();
  const bytes = Buffer.from(JSON.stringify(content));
  await writeFile(path, bytes);
  const forgedManifest = structuredClone(state);
  forgedManifest.loopRuns = [{ ...entry, sha256: sha(bytes) }];
  await assert.rejects(workspace.validateState(caseId, forgedManifest), /LOOP_RUN_INVALID/);
});
