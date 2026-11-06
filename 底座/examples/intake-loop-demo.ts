import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import {
  CASE_CAPABILITIES, caseRecordSchema, createRuntime, materialSchema,
  textVersionViewSchema, type CapabilityRef, type PluginHost,
} from '../src/index.ts';
import { CaseStore } from '../src/cases/store.ts';
import { IntakeLoop } from '../src/loops/engine.ts';
import { LoopRunStore } from '../src/loops/store.ts';
import { loopRunSchema, type LoopRun, type LoopSource } from '../src/loops/contracts.ts';
import { createLoopExamplePlugins, EXAMPLE_LOOP_REFS, EXAMPLE_LOOP_TEXTS } from './loop-fixtures.ts';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string', default: './runtime-data' } } });
const dataDir = values['data-dir'];
async function invoke(host: PluginHost, ref: CapabilityRef, input: unknown): Promise<unknown> {
  const result = await host.invoke(ref, input);
  if (result.status !== 'success') throw new Error(JSON.stringify(result));
  return result.data;
}
const host = await createRuntime({ dataDir, plugins: createLoopExamplePlugins() });
let saved: LoopRun;
try {
  const record = caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.create, {
    title: '虚构案件：需求与读取核对循环', actor: '演示用户',
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
  const run = await new IntakeLoop(host).run({
    caseId: record.id, goal: '整理停止到岗与后续工作安排的已有陈述，并保留出处。',
    sources, ...EXAMPLE_LOOP_REFS,
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.rounds.length, 2);
  saved = await new LoopRunStore(dataDir, new CaseStore(dataDir)).save(run);
} finally { await host.stop(); }

const restarted = await createRuntime({ dataDir });
try {
  const restored = loopRunSchema.parse(await new LoopRunStore(dataDir, new CaseStore(dataDir)).read({
    caseId: saved.caseId, runId: saved.id,
  }));
  assert.deepEqual(restored, saved);
  const sourceLabels = new Map(Object.values(EXAMPLE_LOOP_TEXTS).map((item) => [item.text, item.sourceLabel]));
  console.log('本演示使用确定性的 test 插件，没有调用 LLM，也没有作出法律判断。');
  console.log(`信息需求：${restored.needs[0]!.question}`);
  for (const round of restored.rounds) {
    console.log(`第 ${round.number} 轮：${round.attempts.map((attempt) => attempt.request.instruction).join('；')}`);
    for (const attempt of round.attempts) {
      for (const id of attempt.findingIds) {
        const finding = restored.findings.find((item) => item.id === id)!;
        console.log(`  记录：${finding.statement}`);
        for (const citation of finding.citations) {
          console.log(`  出处：${sourceLabels.get(citation.quote)}，版本 ${citation.versionId}，原文位置 [${citation.start}, ${citation.end})`);
        }
      }
    }
    for (const request of round.review.nextRequests) console.log(`  补查理由：${request.reason}`);
  }
  console.log(`终止原因：${restored.reason}`);
  console.log(JSON.stringify({ caseId: restored.caseId, runId: restored.id, status: restored.status,
    roundCount: restored.rounds.length, findingCount: restored.findings.length,
    restoredAfterRestart: true, usesLlm: false }, null, 2));
} finally { await restarted.stop(); }
