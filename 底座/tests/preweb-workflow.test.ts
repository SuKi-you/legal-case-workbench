import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createLaborPlugin } from '../../劳动法插件/src/index.ts';
import { createLegalAgent } from '../src/agent/engine.ts';
import type { AgentState } from '../src/agent/contracts.ts';
import { CaseRollback } from '../src/cases/rollback.ts';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import type { StructuredNeed } from '../src/information/contracts.ts';
import type { JsonModel } from '../src/information/model.ts';
import { listCaseOutputs, readCaseOutput } from '../src/outputs/store.ts';

const profileId = 'labor.intake';
const wageStandard = 'labor.need.wage-standard';
const wagePayment = 'labor.need.wage-payment';
const agreement = '试验员工乔乙2025年11月工资约定6100元。';
const response = '试验单位答辩称，乔乙2025年11月工资约定5900元。';
const receipt = '试验单位于2025年12月2日向乔乙实际支付2025年11月工资4900元，回单号T-TEST-001。';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-preweb-workflow-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const cases = new CaseStore(dataDir);
  const workspace = new CaseWorkspace(dataDir, cases);
  const record = await cases.create({ title: '虚构工资材料连续流程', actor: '测试' });
  const plugin = createLaborPlugin({ issues: ['labor.wage'] });
  const add = (sourceLabel: string, text: string) => workspace.registerText({ caseId: record.id, sourceLabel, text });
  return { dataDir, cases, workspace, record, plugin, add };
}

function extractionModel() {
  let calls = 0;
  const model: JsonModel = {
    id: 'preweb-fixture', model: 'deterministic',
    async complete({ system, user }) {
      calls++;
      const payload = JSON.parse(user) as { needs: StructuredNeed[]; segment: { id: string; text: string };
        items?: { needId: string }[] };
      assert.ok(payload.segment, 'Named workflows must not call a free-form planner or reply model.');
      const segment = payload.segment;
      if (payload.items) {
        assert.match(system, /INFORMATION_SEMANTIC_REVIEW/u);
        return { verdicts: payload.items.map(({ needId }, index) => ({
          index, relevant: !(segment.text === agreement && needId === wagePayment),
          supported: true, rolesCorrect: true, polarityCorrect: true,
          reason: '约定金额不能充当实付凭证。',
        })) };
      }
      return { results: payload.needs.map((need) => {
        const isPayment = need.id === wagePayment && segment.text === receipt;
        const isStandard = need.id === wageStandard && [agreement, response].includes(segment.text);
        const badPayment = need.id === wagePayment && segment.text === agreement;
        if (!isPayment && !isStandard && !badPayment) return { needId: need.id, items: [] };
        const amount = segment.text.match(/\d+元/u)![0];
        return { needId: need.id, items: [{
          statement: segment.text,
          record: {
            topic: need.spec!.topic,
            subject: { name: '乔乙', kind: 'person', identity: null }, object: null, attributedTo: null,
            event: { type: need.spec!.topic, key: isPayment ? 'T-TEST-001' : null, description: segment.text },
            time: { raw: isPayment ? '2025年12月2日' : null, start: null, end: null, precision: isPayment ? 'date' : 'unknown' },
            value: { kind: 'money', raw: amount, normalized: null, unit: null }, polarity: 'affirmed',
            period: '2025-11', basis: null, origin: 'party_statement', qualifiers: {}, uncertainty: [],
          },
          quotes: [{ segmentId: segment.id, quote: segment.text, occurrence: null }],
        }] };
      }) };
    },
  };
  return { model, calls: () => calls };
}

function currentTask(state: AgentState) {
  return state.tasks.find((task) => task.id === state.activeTaskId)!;
}

async function savedWorkflowOutput(state: AgentState, dataDir: string) {
  const task = currentTask(state);
  assert.equal(task.status, 'completed', task.error);
  const step = state.steps.find((item) => item.taskId === task.id && item.toolId === 'output.create' && item.status === 'completed');
  assert.ok(step);
  const output = await readCaseOutput({ dataDir, caseId: state.caseId, outputId: step.operationId });
  const [json, markdown, docx] = await Promise.all([
    readFile(output.paths.json, 'utf8'), readFile(output.paths.md, 'utf8'), readFile(output.paths.docx),
  ]);
  assert.deepEqual(JSON.parse(json), output.draft);
  assert.equal(markdown, output.markdown);
  assert.equal(docx.readUInt32LE(0), 0x04034b50);
  assert.equal(docx.length, output.manifest.files.docx.byteLength);
  return output;
}

test('public workflows keep truthful coverage through intake, two material changes, and hearing preparation', async (t) => {
  const f = await fixture(t);
  await f.add('来件登记', '第一份试验材料只有来件登记。');
  const firstMaterial = await f.add('工资约定', agreement);
  const script = extractionModel();
  const agent = await createLegalAgent({ dataDir: f.dataDir, model: script.model, extensions: [f.plugin] });
  t.after(() => agent.close());
  const input = { caseId: f.record.id };
  const initialState = await agent.runWorkflow({ ...input, workflow: { kind: 'intake', profileId } });
  const intake = await savedWorkflowOutput(initialState, f.dataDir);
  assert.equal(intake.currentInputMatches, true);
  assert.equal(intake.analysisCoversCurrentInput, false);
  assert.equal(intake.draft.readIssues?.find((issue) => issue.needId === wagePayment)?.source.materialId, firstMaterial.id);
  assert.equal(intake.draft.analysis?.needs.find((need) => need.needId === wagePayment)?.unread[0]?.materialId, firstMaterial.id);
  assert.match(intake.markdown.replaceAll('\\_', '_'), /读取复核未通过的范围[\s\S]*工资约定[\s\S]*INFORMATION_SEMANTIC_REJECTED/u);
  assert.match(initialState.messages.at(-1)!.text, /1 个尚未完成读取核对/u);
  assert.equal(currentTask(initialState).usedModelCalls, script.calls());
  const rollback = new CaseRollback(f.cases, f.workspace);
  const checkpoint = await rollback.createCheckpoint({ ...input, label: '接案已保存', actor: '测试' });
  const secondMaterial = await f.add('公司答辩', response);
  const replyState = await agent.runWorkflow({ ...input, sessionId: initialState.id,
    workflow: { kind: 'opponent_response', profileId, previousOutputId: intake.manifest.outputId } });
  const replied = await savedWorkflowOutput(replyState, f.dataDir);
  const reply = replied.draft.nodeReview!;
  assert.equal(reply.kind, 'opponent_response');
  assert.equal(reply.baselineRunId, intake.draft.runId);
  assert.ok(reply.sources.some((source) => source.kind === 'added' && source.materialId === secondMaterial.id));
  assert.ok(reply.facts.some((change) => change.after.some((item) => item.citations.some((cite) => cite.quote === response))));
  assert.ok(reply.preparations.some((item) => item.id === 'labor.node.response-payment'));
  const thirdMaterial = await f.add('银行付款回单', receipt);
  const reviewState = await agent.runWorkflow({ ...input, sessionId: initialState.id,
    workflow: { kind: 'new_evidence', profileId, previousOutputId: replied.manifest.outputId,
      sourceKinds: { [thirdMaterial.id]: 'document_record' } } });
  const reviewed = await savedWorkflowOutput(reviewState, f.dataDir);
  assert.equal(reviewed.draft.nodeReview?.kind, 'new_evidence');
  assert.ok(reviewed.draft.nodeReview?.facts.some((change) => change.after.some((item) => item.citations.some((cite) => cite.quote === receipt))));
  assert.ok(reviewed.draft.nodeReview?.preparations.some((item) => item.id === 'labor.node.payment-update'));
  assert.equal(reviewed.draft.nodeReview?.status, 'requires_review');
  const beforeReuse = script.calls();
  const hearingState = await agent.runWorkflow({ ...input, sessionId: initialState.id,
    workflow: { kind: 'hearing_preparation', profileId, previousOutputId: reviewed.manifest.outputId, runId: reviewed.draft.runId } });
  const hearing = await savedWorkflowOutput(hearingState, f.dataDir);
  assert.equal(hearing.draft.nodeReview?.kind, 'hearing_preparation');
  assert.equal(hearing.draft.runId, reviewed.draft.runId);
  assert.equal(currentTask(hearingState).usedModelCalls, 0);
  assert.equal(script.calls(), beforeReuse);
  assert.ok(hearing.draft.nodeReview?.preparations.some((item) => item.id === 'labor.node.hearing-payment'));
  assert.match(hearing.markdown, /庭前准备/u);
  assert.match(hearing.markdown.replaceAll('\\_', '_'), /INFORMATION_SEMANTIC_REJECTED/u);

  const otherCase = await f.cases.create({ title: '独立虚构案件', actor: '测试' });
  const wrongCase = await agent.runWorkflow({ caseId: otherCase.id,
    workflow: { kind: 'hearing_preparation', profileId, previousOutputId: reviewed.manifest.outputId, runId: reviewed.draft.runId } });
  assert.equal(currentTask(wrongCase).status, 'failed');
  assert.deepEqual(await listCaseOutputs({ dataDir: f.dataDir, caseId: otherCase.id }), []);
  const { version } = await f.workspace.readVersion({ ...input, materialId: thirdMaterial.id, versionId: thirdMaterial.id });
  await f.workspace.saveRevision({ ...input, materialId: thirdMaterial.id, baseVersionId: version.id, baseTextSha256: version.textSha256,
    text: receipt.replace('4900元', '4800元'), editor: '测试' });
  const stale = await agent.runWorkflow({ ...input, workflow: { kind: 'hearing_preparation', profileId,
    previousOutputId: hearing.manifest.outputId, runId: reviewed.draft.runId } });
  assert.equal(currentTask(stale).status, 'failed');
  assert.match(currentTask(stale).error ?? '', /AGENT_OUTPUT_STALE/u);
  assert.equal(script.calls(), beforeReuse);
  assert.equal((await listCaseOutputs({ dataDir: f.dataDir, ...input })).length, 4);

  const preview = await rollback.preview({ ...input, checkpointId: checkpoint.id });
  const restored = await rollback.apply({ ...input, checkpointId: checkpoint.id, expectedRevision: preview.expectedRevision,
    previewToken: preview.token, actor: '测试' });
  assert.deepEqual((await listCaseOutputs({ dataDir: f.dataDir, ...input })).map((item) => item.outputId), [intake.manifest.outputId]);
  await assert.rejects(readCaseOutput({ dataDir: f.dataDir, ...input, outputId: hearing.manifest.outputId }), /OUTPUT_NOT_ACTIVE/u);
  const undo = await rollback.preview({ ...input, checkpointId: restored.undoCheckpoint.id });
  await rollback.apply({ ...input, checkpointId: restored.undoCheckpoint.id, expectedRevision: undo.expectedRevision,
    previewToken: undo.token, actor: '测试' });
  const restoredHearing = await readCaseOutput({ dataDir: f.dataDir, ...input, outputId: hearing.manifest.outputId });
  assert.deepEqual(restoredHearing.manifest, hearing.manifest);
  assert.equal(restoredHearing.currentInputMatches, false, 'Undo restores the later text revision as well as the historical document.');
});

test('workflow resume cannot spend past its original persisted model budget', async (t) => {
  const f = await fixture(t);
  await f.add('登记一', '第一份虚构无相关记录材料。');
  await f.add('登记二', '第二份虚构无相关记录材料。');
  const controller = new AbortController();
  let calls = 0;
  const model: JsonModel = { id: 'workflow-budget', model: 'deterministic', async complete({ user }) {
    calls++;
    const request = JSON.parse(user) as { needs: StructuredNeed[] };
    return { results: request.needs.map(({ id }) => ({ needId: id, items: [] })) };
  } };
  const options = { dataDir: f.dataDir, model, profiles: [f.plugin.profiles![0]!] };
  const first = await createLegalAgent({ ...options, onEvent: (event) => {
    if (event.kind === 'checkpoint' && calls === 1) controller.abort();
  } });
  t.after(() => first.close());
  const input = { caseId: f.record.id };
  const interrupted = await first.runWorkflow({ ...input, workflow: { kind: 'intake', profileId },
    limits: { maxModelCalls: 1 }, signal: controller.signal });
  assert.equal(currentTask(interrupted).status, 'interrupted');
  assert.equal(currentTask(interrupted).usedModelCalls, 1);
  const later = await createLegalAgent(options);
  t.after(() => later.close());
  const resumed = await later.resume({ ...input, sessionId: interrupted.id });
  assert.equal(currentTask(resumed).status, 'failed');
  assert.match(currentTask(resumed).error ?? '', /INFORMATION_MODEL_BUDGET|AGENT_MODEL_BUDGET/u);
  assert.equal(currentTask(resumed).usedModelCalls, 1);
  assert.equal(calls, 1);
  assert.deepEqual(await listCaseOutputs({ dataDir: f.dataDir, ...input }), []);
});
