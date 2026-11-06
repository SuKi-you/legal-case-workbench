import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLegalAgent } from '../src/agent/engine.ts';
import type { AgentState } from '../src/agent/contracts.ts';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { LoopRunStore } from '../src/loops/store.ts';
import { listCaseOutputs, readCaseOutput } from '../src/outputs/store.ts';
import { createDeepSeekModel, loadDeepSeekConfig } from '../src/information/deepseek.ts';
import type { JsonModel } from '../src/information/model.ts';
import extension from './plugins/transfer-review.ts';

const first = '【虚构转账记录】周岚（人员编号P014）向星河服务中心（登记编号R203）付款，流水号TX-0416。付款日期2025年4月16日，所属期间2025年4月，金额口径实际到账，金额人民币1.25万元。';
const second = '【虚构说明】周岚（人员编号P014）陈述：向星河服务中心（登记编号R203）的付款，流水号TX-0416，付款日期2025年4月16日，所属期间2025年4月，金额口径实际到账，我记载的是人民币12500元。';
const supplement = '【虚构补充登记】周岚（人员编号P014）向星河服务中心（登记编号R203）付款，流水号TX-0416。付款日期2025年4月16日，所属期间2025年4月，金额口径实际到账，这份登记记载金额为人民币12000元。';
const active = (state: AgentState) => state.tasks.find((task) => task.id === state.activeTaskId)!;

export async function runAgentDemo(dataDir = resolve('runtime-data')) {
  const cases = new CaseStore(dataDir), workspace = new CaseWorkspace(dataDir, cases);
  const record = await cases.create({ title: '虚构 Agent 执行与导出验收', actor: '端到端验收' });
  for (const [index, text] of [first, second].entries()) await workspace.registerText({ caseId: record.id, sourceLabel: `虚构材料${index + 1}`, text });
  const base = createDeepSeekModel({ ...loadDeepSeekConfig(), timeoutMs: 180000 });
  const reads = new Map<string, number>(); let calls = 0;
  const model: JsonModel = { id: base.id, model: base.model, complete: async (input) => {
    calls += 1;
    if (input.system.includes('你是材料信息读取器')) {
      const payload = JSON.parse(input.user); const text = payload.segment.text as string;
      reads.set(text, (reads.get(text) ?? 0) + 1);
    }
    return base.complete(input);
  } };
  let agent: Awaited<ReturnType<typeof createLegalAgent>> | undefined;
  const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), caseId: record.id, syntheticMaterialsOnly: true,
    provider: base.id, model: base.model, timeoutMs: 180000, passed: false };
  try {
    const controller = new AbortController();
    agent = await createLegalAgent({ dataDir, model, extensions: [extension], onEvent: (event) => {
      console.log(`[${event.kind}] ${event.message}`);
      if (event.kind === 'checkpoint' && !event.message.includes('0 条记录')) controller.abort();
    } });
    const initial = await agent.send({ caseId: record.id, signal: controller.signal,
      message: '使用example.transfer-amount配置，整理本案全部材料，检查记录关系并生成接案底稿。请实际执行；必要信息已在材料中。' });
    assert.equal(active(initial).status, 'interrupted');
    const partial = initial.steps.find((step) => step.partial?.information?.findings.length);
    assert.ok(partial?.partial?.information); const firstReadCalls = reads.get(first) ?? 0;
    report.sessionId = initial.id; report.interruptedAfterConfirmedRead = true;
    await agent.close();
    agent = await createLegalAgent({ dataDir, model, extensions: [extension], onEvent: (event) => console.log(`[${event.kind}] ${event.message}`) });
    const resumed = await agent.resume({ caseId: record.id, sessionId: initial.id });
    assert.equal(active(resumed).status, 'completed', active(resumed).error);
    assert.equal(reads.get(first), firstReadCalls, '已经确认完成的首次材料读取不应在恢复时重复');
    assert.ok(active(resumed).usedModelCalls > active(initial).usedModelCalls);
    const oldOutputs = await listCaseOutputs({ dataDir, caseId: record.id }); assert.equal(oldOutputs.length, 1);
    const oldOutput = oldOutputs[0]!;
    report.resumedWithoutRereading = true; report.budgetRetained = true; report.firstOutputId = oldOutput.outputId;
    await agent.close();
    agent = await createLegalAgent({ dataDir, model, extensions: [extension], onEvent: (event) => console.log(`[${event.kind}] ${event.message}`) });
    const updated = await agent.send({ caseId: record.id, sessionId: initial.id,
      message: `补充一份原文材料，请先逐字登记下面这段事实，再使用example.transfer-amount重新整理全部材料，并以旧底稿${oldOutput.outputId}为前版生成新底稿和变化清单：\n${supplement}` });
    assert.equal(active(updated).status, 'completed', active(updated).error);
    const outputs = await listCaseOutputs({ dataDir, caseId: record.id }); assert.equal(outputs.length, 2);
    const newest = outputs.find((item) => item.outputId !== oldOutput.outputId)!;
    assert.equal(newest.previousOutputId, oldOutput.outputId);
    const run = await new LoopRunStore(dataDir).read({ caseId: record.id, runId: newest.runId });
    assert.ok(run.information?.conflicts.some((conflict) => conflict.classification === 'inconsistent'));
    assert.ok(run.findings.some((finding) => finding.record?.value.normalized === '12000'));
    const exported = await readCaseOutput({ dataDir, caseId: record.id, outputId: newest.outputId });
    assert.ok(exported.draft.changes); assert.ok(exported.draft.references.length > 0);
    report.supplementPreserved = true; report.newConflictFound = true; report.oldOutputPreserved = true;
    report.newOutputId = newest.outputId; report.files = exported.paths; report.passed = true;
    console.log(`Word底稿：${exported.paths.docx}`);
  } catch (error) { report.error = error instanceof Error ? error.message : '验收失败'; process.exitCode = 1; }
  finally { await agent?.close(); }
  report.modelCalls = calls;
  const directory = join(dataDir, 'evaluations'); await mkdir(directory, { recursive: true });
  const path = join(directory, `agent-execution-output-${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2)); console.log(`验收记录：${path}`); return report;
}
if (import.meta.main) await runAgentDemo();
