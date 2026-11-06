import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CASE_CAPABILITIES, caseRecordSchema, createRuntime, materialSchema,
  textVersionViewSchema, type CapabilityRef, type PluginHost,
} from '../src/index.ts';
import { IntakeLoop } from '../src/loops/engine.ts';
import { LoopRunStore } from '../src/loops/store.ts';
import { CaseStore } from '../src/cases/store.ts';
import { loopRunSchema, type LoopRun, type LoopSource } from '../src/loops/contracts.ts';
import { createLoopExamplePlugins, EXAMPLE_LOOP_REFS, EXAMPLE_LOOP_TEXTS } from '../examples/loop-fixtures.ts';

async function directoryFor(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-loop-example-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function invoke(host: PluginHost, ref: CapabilityRef, input: unknown): Promise<unknown> {
  const result = await host.invoke(ref, input);
  if (result.status !== 'success') assert.fail(JSON.stringify(result));
  return result.data;
}
async function inputs(host: PluginHost) {
  const record = caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.create, {
    title: '虚构循环测试案', actor: '测试用户',
  }));
  const sources: LoopSource[] = [];
  for (const fixture of Object.values(EXAMPLE_LOOP_TEXTS)) {
    const material = materialSchema.parse(await invoke(host, CASE_CAPABILITIES.registerText, {
      caseId: record.id, ...fixture,
    }));
    const { version } = textVersionViewSchema.parse(await invoke(host, CASE_CAPABILITIES.readVersion, {
      caseId: record.id, materialId: material.id, versionId: material.id,
    }));
    sources.push({ materialId: material.id, versionId: version.id, textSha256: version.textSha256 });
  }
  return { caseId: record.id, sources, goal: '整理已有的停止到岗及后续安排陈述。', ...EXAMPLE_LOOP_REFS };
}

test('the deterministic example coordinates two reads, preserves exact statements and survives case storage restart', async (t) => {
  const dataDir = await directoryFor(t);
  const host = await createRuntime({ dataDir, plugins: createLoopExamplePlugins() });
  let run: LoopRun | undefined;
  try {
    const input = await inputs(host);
    run = loopRunSchema.parse(await new IntakeLoop(host).run(input));
    assert.equal(run.status, 'completed');
    assert.equal(run.rounds.length, 2);
    assert.equal(run.rounds[0]!.review.assessments[0]!.status, 'unresolved');
    assert.equal(run.rounds[1]!.review.assessments[0]!.status, 'satisfied');
    assert.match(run.rounds[0]!.review.nextRequests[0]!.reason, /后.*安排|补查/);
    assert.notEqual(run.rounds[0]!.attempts[0]!.request.instruction, run.rounds[1]!.attempts[0]!.request.instruction);
    assert.equal(run.rounds[0]!.attempts[0]!.examined.length, 1);
    assert.equal(run.rounds[1]!.attempts[0]!.examined.length, 1);
    assert.notEqual(run.rounds[0]!.attempts[0]!.examined[0]!.materialId, run.rounds[1]!.attempts[0]!.examined[0]!.materialId);
    assert.deepEqual(run.findings.map((finding) => finding.citations[0]!.quote), Object.values(EXAMPLE_LOOP_TEXTS).map((item) => item.text));
    for (const finding of run.findings) {
      assert.match(finding.statement, /^当事人陈述/);
      for (const citation of finding.citations) {
        const { version } = textVersionViewSchema.parse(await invoke(host, CASE_CAPABILITIES.readVersion, {
          caseId: run.caseId, materialId: citation.materialId, versionId: citation.versionId,
        }));
        assert.equal(version.textSha256, citation.textSha256);
        assert.equal(version.text.slice(citation.start, citation.end), citation.quote);
      }
    }
    assert.match(run.findings[0]!.statement, /上周主管口头/);
    assert.match(run.findings[1]!.statement, /没有再联系/);
    await new LoopRunStore(dataDir, new CaseStore(dataDir)).save(run);
  } finally { await host.stop(); }
  assert.ok(run);
  const restarted = await createRuntime({ dataDir });
  try {
    const restored = loopRunSchema.parse(await new LoopRunStore(dataDir, new CaseStore(dataDir)).read({ caseId: run.caseId, runId: run.id }));
    assert.deepEqual(restored, run);
    assert.equal(restored.providers.read.pluginId, 'example.intake-reader-test');
  } finally { await restarted.stop(); }
});

test('replacing the example professional strategy changes the number of rounds without changing the loop or contracts', async (t) => {
  const dataDir = await directoryFor(t);
  const host = await createRuntime({ dataDir, plugins: createLoopExamplePlugins('read-together') });
  try {
    const run = await new IntakeLoop(host).run(await inputs(host));
    assert.equal(run.status, 'completed');
    assert.equal(run.rounds.length, 1);
    assert.equal(run.findings.length, 2);
    assert.equal(run.rounds[0]!.attempts[0]!.examined.length, 2);
    assert.equal(run.providers.declare.pluginVersion, '1.0.0-together-test');
    assert.deepEqual(run.rounds[0]!.review.nextRequests, []);
  } finally { await host.stop(); }
});

test('the real IDE demo prints its two-round trace and identifies its test-only reader', async (t) => {
  const directory = await directoryFor(t);
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../examples/intake-loop-demo.ts', import.meta.url)), '--data-dir', directory,
  ]);
  assert.match(stdout, /确定性的 test 插件，没有调用 LLM/);
  assert.match(stdout, /第 1 轮/);
  assert.match(stdout, /第 2 轮/);
  assert.match(stdout, /补查理由/);
  assert.match(stdout, /上周主管口头说让我别来了/);
  assert.match(stdout, /此后公司没有再联系我安排工作/);
  assert.match(stdout, /"restoredAfterRestart": true/);
  assert.match(stdout, /"usesLlm": false/);
});
