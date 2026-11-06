import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { LegalAgent, type LegalAgentOptions } from '../src/agent/engine.ts';
import { AgentError, agentStateSchema, type AgentAction, type AgentState } from '../src/agent/contracts.ts';
import type { InformationProfile } from '../src/agent/profiles.ts';
import { defineAgentTool, type AgentTool } from '../src/agent-tools/contracts.ts';
import { createCaseTools } from '../src/agent-tools/case-tools.ts';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { CaseRollback } from '../src/cases/rollback.ts';
import { ExecutionStore } from '../src/execution/store.ts';
import { LoopRunStore } from '../src/loops/store.ts';
import { readCaseOutput } from '../src/outputs/store.ts';
import type { JsonModel } from '../src/information/model.ts';
import type { InformationRecord } from '../src/information/contracts.ts';

type Observation = { stepId: string; taskId: string; toolId: string; currentInput: boolean; result: unknown };
type PlannerInput = { task: { id: string; goal: string }; observations: Observation[]; messages: { text: string; role: string }[];
  failedSteps?: { toolId: string; input: unknown; error: string }[];
  assistantProfile?: Record<string, unknown>;
  replyFeedback?: { candidate: Exclude<AgentAction, { kind: 'tool' }>; verdict: { supported: boolean; necessary: boolean; reason: string } | null; createdAt: string }[] };
type ReplyReviewInput = {
  goal: string; candidate: Exclude<AgentAction, { kind: 'tool' }>;
  assistantProfile?: Record<string, unknown>;
  observations: Observation[]; messages: { text: string; role: string }[]; tools: { id: string }[];
};
type ExtractionInput = { needs: { spec: { topic: string } }[]; segment: { id: string; text: string; sourceLabel: string } };
type JsonValue = z.infer<ReturnType<typeof z.json>>;
const invoke = (toolId: string, arguments_: Record<string, JsonValue> = {}): AgentAction => ({ kind: 'tool', toolId, toolVersion: 1, arguments: arguments_, reason: '按当前任务检查实际案件数据' });
const reply = (observations: Observation[], message = '已按当前案件工具结果完成检查。'): AgentAction => ({ kind: 'reply', message, evidenceStepIds: observations.map((item) => item.stepId) });
const current = (input: PlannerInput) => input.observations.filter((item) => item.taskId === input.task.id);
const active = (state: AgentState) => state.tasks.find((task) => task.id === state.activeTaskId)!;
const profile: InformationProfile = { id: 'test.payment', version: '1', description: '独立虚构付款信息需求', needs: [{ id: 'test.amount', question: '甲的流水T1记载了什么实付金额？', reason: '对照同笔交易的实付款项记载', spec: {
  topic: 'payment.actual', subject: '甲', object: null, period: '2026-09', basis: '实付',
  requiredFields: ['subject', 'event.key', 'time', 'value', 'period', 'basis'], minimumSupport: 'statement', applicable: true,
} }] };
const paymentText = (amount: number) => `甲（工号E1）2026年9月10日实付${amount}元，流水T1，所属期间2026年9月。`;
function extraction(payload: ExtractionInput) {
  const amount = /实付(\d+)元/u.exec(payload.segment.text)?.[1];
  if (!amount) return { items: [] };
  const record: InformationRecord = { topic: payload.needs[0]!.spec.topic,
    subject: { name: '甲', kind: 'person', identity: { scheme: 'employee_id', value: 'E1' } }, object: null, attributedTo: null,
    event: { type: 'transfer', key: 'T1', description: '流水T1的实付金额' }, time: { raw: '2026年9月10日', start: null, end: null, precision: 'unknown' },
    value: { kind: 'money', raw: `${amount}元`, normalized: null, unit: null }, polarity: 'affirmed', period: '2026-09', basis: '实付', origin: 'party_statement', qualifiers: {}, uncertainty: [] };
  return { items: [{ statement: `甲的流水T1记载实付${amount}元。`, record, quotes: [{ segmentId: payload.segment.id, quote: payload.segment.text, occurrence: null }] }] };
}
function fakeModel(planner: (input: PlannerInput) => unknown | Promise<unknown>, options: {
  extract?: (input: ExtractionInput) => unknown | Promise<unknown>;
  reviewReply?: (input: ReplyReviewInput) => unknown | Promise<unknown>;
  onAction?: () => void;
} = {}) {
  const calls: { kind: 'action' | 'reply-review' | 'extract' | 'semantic'; label?: string }[] = [];
  const model: JsonModel = { id: 'scripted-agent-engine-test', model: 'fictional-only', complete: async ({ system, user }) => {
    if (system.includes('LEGAL_AGENT_ACTION')) { calls.push({ kind: 'action' }); options.onAction?.(); return planner(JSON.parse(user) as PlannerInput); }
    if (system.includes('LEGAL_AGENT_REPLY_REVIEW')) { calls.push({ kind: 'reply-review' }); return options.reviewReply ? options.reviewReply(JSON.parse(user) as ReplyReviewInput) : { supported: true, necessary: true, reason: '独立机制夹具，仅接受本测试预设回复' }; }
    if (system.includes('INFORMATION_SEMANTIC_REVIEW')) {
      const payload = JSON.parse(user) as { items: unknown[] }; calls.push({ kind: 'semantic' });
      return { verdicts: payload.items.map((_, index) => ({ index, relevant: true, supported: true, rolesCorrect: true, polarityCorrect: true, reason: '仅测试机制，提取内容由独立夹具固定' })) };
    }
    const payload = JSON.parse(user) as ExtractionInput; calls.push({ kind: 'extract', label: payload.segment.sourceLabel });
    return options.extract ? options.extract(payload) : extraction(payload);
  } }; return { model, calls };
}
async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-engine-')), cases = new CaseStore(dataDir), workspace = new CaseWorkspace(dataDir, cases);
  const first = await cases.create({ title: '虚构终端执行验收', actor: '测试' }), second = await cases.create({ title: '独立案件', actor: '测试' });
  const agents: LegalAgent[] = [];
  t.after(async () => { for (const agent of agents) await agent.close(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); await rm(dataDir, { recursive: true, force: true }); });
  const create = async (model: JsonModel, options: Omit<LegalAgentOptions, 'dataDir' | 'model'> = {}) => {
    const agent = await LegalAgent.create({ dataDir, model, ...options }); agents.push(agent); return agent;
  };
  return { dataDir, cases, workspace, first, second, create };
}

test('two natural-language turns execute real case tools and preserve independent session history after restart', async (t) => {
  const f = await fixture(t); await f.workspace.registerText({ caseId: f.first.id, sourceLabel: '初次陈述', text: '主管口头说让我别来了。' });
  const script = fakeModel((input) => {
    const observed = current(input), desired = input.task.goal.includes('材料') ? 'case.materials' : 'case.overview';
    return observed.length ? reply(observed) : invoke(desired);
  });
  const agent = await f.create(script.model);
  const first = await agent.send({ caseId: f.first.id, message: '请查看案件概况' });
  assert.equal(active(first).status, 'completed'); assert.equal(first.steps[0]!.toolId, 'case.overview');
  const second = await agent.send({ caseId: f.first.id, sessionId: first.id, message: '再列出材料' });
  assert.equal(active(second).status, 'completed'); assert.equal(second.tasks.length, 2); assert.equal(second.steps.length, 2);
  assert.equal(second.messages.filter((item) => item.role === 'assistant').length, 2);
  const materialResult = second.steps[1]!.result as { materials: { sourceLabel: string }[] };
  assert.equal(materialResult.materials[0]!.sourceLabel, '初次陈述');
  const restarted = await f.create(script.model); assert.deepEqual(await restarted.read({ caseId: f.first.id, sessionId: first.id }), second);
  assert.equal((await restarted.sessions(f.first.id)).length, 1); assert.equal((await restarted.sessions(f.second.id)).length, 0);
  await assert.rejects(restarted.read({ caseId: f.second.id, sessionId: first.id }), /EXECUTION_NOT_ACTIVE/);
});

test('a cancelled in-flight read resumes from the saved pending step without reserving another tool step', async (t) => {
  const f = await fixture(t), controller = new AbortController(); let reads = 0;
  const tool = defineAgentTool({ id: 'test.long-read', version: 1, description: '可中断的读取夹具', effect: 'read', input: z.strictObject({}), inputSchema: { type: 'object' },
    execute: async () => { reads += 1; if (reads === 1) controller.abort(); return { read: true }; } });
  const script = fakeModel((input) => current(input).length ? reply(current(input)) : invoke(tool.id));
  const interrupted = await (await f.create(script.model, { tools: [tool] })).send({ caseId: f.first.id, message: '执行长读取', signal: controller.signal });
  assert.equal(active(interrupted).status, 'interrupted'); assert.equal(interrupted.steps[0]!.status, 'running');
  const resumed = await (await f.create(script.model, { tools: [tool] })).resume({ caseId: f.first.id, sessionId: interrupted.id });
  assert.equal(active(resumed).status, 'completed'); assert.equal(reads, 2); assert.equal(active(resumed).usedSteps, 1);
  assert.equal(resumed.steps[0]!.status, 'completed'); assert.equal(active(resumed).usedModelCalls, script.calls.length);
});

test('completed read steps are reused after interruption while the next planning call is retried', async (t) => {
  const f = await fixture(t), controller = new AbortController(); let reads = 0, actions = 0;
  const tool = defineAgentTool({ id: 'test.once-read', version: 1, description: '读回检查', effect: 'read', input: z.strictObject({}), inputSchema: { type: 'object' }, execute: async () => { reads += 1; return { verified: true }; } });
  const script = fakeModel((input) => current(input).length ? reply(current(input)) : invoke(tool.id), { onAction: () => { if (++actions === 2) controller.abort(); } });
  const first = await (await f.create(script.model, { tools: [tool] })).send({ caseId: f.first.id, message: '读取后检查', signal: controller.signal });
  assert.equal(active(first).status, 'interrupted'); assert.equal(first.steps[0]!.status, 'completed');
  const final = await (await f.create(script.model, { tools: [tool] })).resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(final).status, 'completed'); assert.equal(reads, 1); assert.equal(active(final).usedModelCalls, 4);
});

test('a multi-material information task resumes its saved read boundary instead of extracting the first source again', async (t) => {
  const f = await fixture(t), controller = new AbortController(); let interrupted = false;
  await f.workspace.registerText({ caseId: f.first.id, sourceLabel: '来源A', text: paymentText(6000) });
  await f.workspace.registerText({ caseId: f.first.id, sourceLabel: '来源B', text: paymentText(8000) });
  const script = fakeModel((input) => current(input).some((item) => item.toolId === 'information.organize')
    ? reply(current(input)) : invoke('information.organize', { profileId: profile.id, selections: [] }), { extract: (input) => {
      if (input.segment.sourceLabel === '来源B' && !interrupted) { interrupted = true; controller.abort(); throw new Error('DEEPSEEK_CANCELLED: fixture interrupted second source'); }
      return extraction(input);
    } });
  const first = await (await f.create(script.model, { profiles: [profile] })).send({ caseId: f.first.id, message: '核对这两份付款材料', signal: controller.signal });
  assert.equal(active(first).status, 'interrupted'); assert.equal(first.steps[0]!.partial?.information?.findings.length, 1);
  const final = await (await f.create(script.model, { profiles: [profile] })).resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(final).status, 'completed'); assert.equal(final.steps.length, 1); assert.equal(final.steps[0]!.status, 'completed');
  assert.equal(script.calls.filter((item) => item.kind === 'extract' && item.label === '来源A').length, 1);
  assert.equal(script.calls.filter((item) => item.kind === 'extract' && item.label === '来源B').length, 2);
  const result = final.steps[0]!.result as { runId: string; findings: unknown[]; status: string };
  assert.equal(result.findings.length, 2); assert.equal(result.status, 'needs_review');
  assert.equal((await new LoopRunStore(f.dataDir).read({ caseId: f.first.id, runId: result.runId })).findings.length, 2);
  assert.equal(active(final).usedModelCalls, script.calls.length);
});

test('a write committed before a lost response is reconciled after restart and never registers the same statement twice', async (t) => {
  const f = await fixture(t), statement = createCaseTools({ dataDir: f.dataDir }).find((tool) => tool.id === 'user.statement.register')!;
  let lost = false;
  const tool: AgentTool = { ...statement, id: 'test.committed-statement', description: '测试写成功但回复丢失',
    execute: async (input, context) => { const result = await statement.execute(input, context); if (!lost) { lost = true; throw new Error('DEEPSEEK_NETWORK_ERROR: stopped after actual commit'); } return result; } };
  const script = fakeModel((input) => {
    if (!input.observations.some((item) => item.toolId === tool.id)) return invoke(tool.id, { text: '主管口头说让我别来了。' });
    if (!current(input).some((item) => item.toolId === 'case.materials')) return invoke('case.materials');
    return reply(current(input));
  });
  const first = await (await f.create(script.model, { tools: [tool] })).send({ caseId: f.first.id, message: '补充：主管口头说让我别来了。' });
  assert.equal(active(first).status, 'interrupted'); assert.equal((await f.workspace.contents(f.first.id)).materials.length, 1);
  const final = await (await f.create(script.model, { tools: [tool] })).resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(final).status, 'completed'); assert.equal((await f.workspace.contents(f.first.id)).materials.length, 1);
  assert.equal(final.steps.find((step) => step.toolId === tool.id)!.status, 'completed');
  assert.equal(active(final).usedModelCalls, script.calls.length);
  assert.equal(active(final).usedSteps, 2);
});

test('model-call reservations survive restart and exhausted budgets do not reset on repeated resume', async (t) => {
  const f = await fixture(t), controller = new AbortController(); let actions = 0;
  const script = fakeModel(() => ({ kind: 'reply', message: '操作说明。', evidenceStepIds: [] }), { onAction: () => { if (++actions === 1) controller.abort(); } });
  const first = await (await f.create(script.model)).send({ caseId: f.first.id, message: '说明操作', limits: { maxModelCalls: 2 }, signal: controller.signal });
  assert.equal(active(first).status, 'interrupted'); assert.equal(active(first).usedModelCalls, 1);
  const agent = await f.create(script.model), second = await agent.resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(second).status, 'failed'); assert.match(active(second).error!, /AGENT_MODEL_BUDGET/); assert.equal(active(second).usedModelCalls, 2);
  const again = await agent.resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(again).usedModelCalls, 2); assert.equal(script.calls.length, 2);
});

test('the persisted tool-step budget stops additional work and remains exhausted after restart', async (t) => {
  const f = await fixture(t);
  const script = fakeModel((input) => current(input).length ? invoke('case.materials') : invoke('case.overview'));
  const first = await (await f.create(script.model)).send({ caseId: f.first.id, message: '检查案件再查材料', limits: { maxSteps: 1 } });
  assert.equal(active(first).status, 'failed'); assert.match(active(first).error!, /AGENT_STEP_BUDGET/); assert.equal(first.steps.length, 1);
  const final = await (await f.create(script.model)).resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(final).usedSteps, 1); assert.equal(final.steps.length, 1); assert.match(active(final).error!, /AGENT_STEP_BUDGET/);
});

test('unknown tools, invalid action envelopes and invented reply references never become successful assistant messages', async (t) => {
  const variants = [
    { proposal: { kind: 'tool', toolId: 'made.up', toolVersion: 1, arguments: {}, reason: '错误夹具' }, error: /TOOL_NOT_FOUND/ },
    { proposal: { kind: 'shell', command: 'do-anything' }, error: /AGENT_ACTION_INVALID/ },
    { proposal: { kind: 'reply', message: '声称已完成', evidenceStepIds: [randomUUID()] }, error: /AGENT_REPLY_REFERENCE_INVALID/ },
  ];
  for (const item of variants) await t.test(String(item.error), async (child) => {
    const f = await fixture(child), script = fakeModel(() => item.proposal);
    const state = await (await f.create(script.model)).send({ caseId: f.first.id, message: '检查任务' });
    assert.equal(active(state).status, 'failed'); assert.match(active(state).error!, item.error);
    assert.equal(state.messages.filter((message) => message.role === 'assistant').length, 0); assert.equal(state.steps.length, 0);
  });
});

test('invalid tool arguments are recorded as a failed step so a resumed task can propose a corrected action', async (t) => {
  const f = await fixture(t); let corrected = false;
  const script = fakeModel((input) => current(input).length ? reply(current(input)) : corrected ? invoke('case.overview') : invoke('case.overview', { invented: true }));
  const first = await (await f.create(script.model)).send({ caseId: f.first.id, message: '查看概况' });
  assert.equal(active(first).status, 'failed'); assert.match(active(first).error!, /TOOL_INPUT_INVALID/); assert.equal(first.steps[0]!.status, 'failed');
  corrected = true;
  const final = await (await f.create(script.model)).resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(final).status, 'completed'); assert.equal(final.steps.length, 2); assert.equal(final.steps[1]!.status, 'completed');
});

test('source review rejects unsupported replies and unnecessary questions before they enter conversation history', async (t) => {
  for (const kind of ['reply', 'ask'] as const) await t.test(kind, async (child) => {
    const f = await fixture(child), script = fakeModel(() => kind === 'reply'
      ? { kind, message: '凭空声称工资8000元。', evidenceStepIds: [] }
      : { kind, message: '主管是否说过让你别来了？', reason: '错误的重复问题', evidenceStepIds: [] },
    { reviewReply: () => ({ supported: kind === 'ask', necessary: kind === 'reply', reason: '错误或重复内容被拒绝' }) });
    const state = await (await f.create(script.model)).send({ caseId: f.first.id, message: '主管已经口头说让我别来了。' });
    assert.equal(active(state).status, 'failed'); assert.match(active(state).error!, /AGENT_REPLY_REJECTED/);
    assert.match(active(state).error!, /错误或重复内容被拒绝/);
    assert.equal(active(state).replyAttempts?.length, 2);
    assert.ok(active(state).replyAttempts?.every((attempt) => attempt.verdict?.reason === '错误或重复内容被拒绝'));
    assert.equal(script.calls.filter((call) => call.kind === 'reply-review').length, 2);
    assert.equal(state.messages.filter((message) => message.role === 'assistant').length, 0);
  });
});

test('a self introduction uses the same trusted assistant profile in planning and review without inventing case facts or calling tools', async (t) => {
  const f = await fixture(t);
  await f.workspace.registerText({ caseId: f.first.id, sourceLabel: '已有的实际材料', text: '用户已经提供一份陈述。' });
  let profileSeen: Record<string, unknown> | undefined;
  const introduction = '我是法律材料工作助手，可以帮助你查看案件材料、整理记录，并生成带出处的底稿。';
  const script = fakeModel((input) => {
    assert.equal(input.task.goal, '介绍一下你自己');
    assert.ok(input.assistantProfile && Object.keys(input.assistantProfile).length > 0);
    profileSeen = input.assistantProfile;
    assert.equal(input.observations.length, 0);
    return { kind: 'reply', message: introduction, evidenceStepIds: [] };
  }, { reviewReply: (input) => {
    assert.deepEqual(input.assistantProfile, profileSeen);
    assert.equal(input.candidate.message, introduction);
    assert.equal(input.observations.length, 0);
    assert.ok(input.tools.some((tool) => tool.id === 'case.materials'));
    assert.ok(input.tools.some((tool) => tool.id === 'output.create'));
    return { supported: true, necessary: true, reason: '能力说明由可信运行时说明及已注册工具支持，未断言当前案件状态。' };
  } });
  const agent = await f.create(script.model), state = await agent.send({ caseId: f.first.id, message: '介绍一下你自己' });
  assert.equal(active(state).status, 'completed'); assert.equal(active(state).usedSteps, 0);
  assert.equal(active(state).usedModelCalls, 2); assert.equal(state.steps.length, 0);
  assert.equal(state.messages.at(-1)!.text, introduction);
  assert.equal(active(state).replyAttempts?.length, 1);
  assert.equal(active(state).replyAttempts?.[0]?.verdict?.supported, true);
  assert.equal((await f.workspace.contents(f.first.id)).materials.length, 1);
  const restored = await (await f.create(script.model)).read({ caseId: f.first.id, sessionId: state.id });
  assert.deepEqual(active(restored).replyAttempts, active(state).replyAttempts);
});

test('introducing the assistant cannot bypass review of invented case state; rejection feedback leads to an actual material lookup and a corrected reply', async (t) => {
  const f = await fixture(t);
  await f.workspace.registerText({ caseId: f.first.id, sourceLabel: '真实存在的夹具材料', text: '已登记材料，不是空案件。' });
  const rejectedIntroduction = '我是法律材料助手。目前这个案件没有任何材料，也没有附件。';
  const reviewReason = '尚未读取材料目录，不能断言当前案件没有材料或附件。';
  let sawFeedback = false, reviewed = 0;
  const script = fakeModel((input) => {
    const materials = current(input).find((item) => item.toolId === 'case.materials');
    if (materials) {
      assert.equal((materials.result as { materials: unknown[] }).materials.length, 1);
      return reply([materials], '我是法律材料助手，可以整理材料和导出底稿。刚才查看的案件目录中有1份材料。');
    }
    if (input.replyFeedback?.length) {
      const rejected = input.replyFeedback.find((attempt) => attempt.candidate.message === rejectedIntroduction);
      assert.ok(rejected); assert.equal(rejected.verdict?.reason, reviewReason);
      assert.equal(rejected.verdict?.supported, false);
      assert.equal(input.messages.some((message) => message.role === 'assistant' && message.text === rejectedIntroduction), false);
      sawFeedback = true; return invoke('case.materials');
    }
    return { kind: 'reply', message: rejectedIntroduction, evidenceStepIds: [] };
  }, { reviewReply: (input) => {
    reviewed += 1;
    if (input.candidate.message === rejectedIntroduction) {
      assert.equal(input.observations.length, 0);
      return { supported: false, necessary: true, reason: reviewReason };
    }
    const source = input.observations.find((item) => item.toolId === 'case.materials');
    assert.ok(source); assert.equal((source.result as { materials: unknown[] }).materials.length, 1);
    assert.ok(input.candidate.evidenceStepIds.includes(source.stepId));
    return { supported: true, necessary: true, reason: '通用能力来自可信说明，案件材料数量来自实际工具结果。' };
  } });
  const state = await (await f.create(script.model)).send({ caseId: f.first.id, message: '介绍一下你自己' });
  assert.equal(active(state).status, 'completed'); assert.equal(sawFeedback, true); assert.equal(reviewed, 2);
  assert.deepEqual(state.steps.map((step) => step.toolId), ['case.materials']);
  assert.equal(active(state).usedModelCalls, 5);
  assert.equal(active(state).replyAttempts?.length, 2);
  assert.equal(active(state).replyAttempts?.[0]?.verdict?.reason, reviewReason);
  assert.equal(active(state).replyAttempts?.[1]?.verdict?.supported, true);
  assert.equal(state.messages.filter((message) => message.role === 'assistant').length, 1);
  assert.notEqual(state.messages.at(-1)!.text, rejectedIntroduction);
});

test('necessity applies to follow-up questions while an otherwise supported reply remains valid', async (t) => {
  const f = await fixture(t);
  const script = fakeModel(() => ({ kind: 'reply', message: '我可以通过已注册工具帮助你查看案件和材料。', evidenceStepIds: [] }),
    { reviewReply: () => ({ supported: true, necessary: false, reason: '这是一段受支持的能力说明，不是需要必要性判断的追问。' }) });
  const state = await (await f.create(script.model)).send({ caseId: f.first.id, message: '你能做什么？' });
  assert.equal(active(state).status, 'completed'); assert.equal(state.messages.at(-1)!.role, 'assistant');
  assert.equal(script.calls.length, 2);
});

test('invalid reply-review envelopes are distinguished from semantic rejection and retained as a null verdict', async (t) => {
  const invalid = [null, { supported: 'true', necessary: true, reason: '格式错误' }, { supported: true, reason: '漏项' }];
  for (const [index, verdict] of invalid.entries()) await t.test(`invalid-${index}`, async (child) => {
    const f = await fixture(child);
    const candidate = { kind: 'reply' as const, message: '我可以查看当前案件的材料目录。', evidenceStepIds: [] };
    const script = fakeModel(() => candidate, { reviewReply: () => verdict });
    const state = await (await f.create(script.model)).send({ caseId: f.first.id, message: '介绍一下功能' });
    assert.equal(active(state).status, 'failed'); assert.match(active(state).error!, /AGENT_REPLY_REVIEW_INVALID/);
    assert.equal(active(state).replyAttempts?.length, 1);
    assert.equal(active(state).replyAttempts?.[0]?.verdict, null);
    assert.deepEqual(active(state).replyAttempts?.[0]?.candidate, candidate);
    assert.equal(state.messages.filter((message) => message.role === 'assistant').length, 0);
    assert.equal(script.calls.length, 2);
    const restored = await (await f.create(script.model)).read({ caseId: f.first.id, sessionId: state.id });
    assert.deepEqual(active(restored).replyAttempts, active(state).replyAttempts);
  });
});

test('a rejected reply cannot spend past the persisted model budget or become a successful message on resume', async (t) => {
  const f = await fixture(t);
  const script = fakeModel(() => ({ kind: 'reply', message: '当前案件没有材料。', evidenceStepIds: [] }),
    { reviewReply: () => ({ supported: false, necessary: true, reason: '没有实际读取结果支持这个案件状态断言。' }) });
  const agent = await f.create(script.model), state = await agent.send({ caseId: f.first.id, message: '介绍一下自己', limits: { maxModelCalls: 2 } });
  assert.equal(active(state).status, 'failed'); assert.equal(active(state).usedModelCalls, 2);
  assert.equal(active(state).replyAttempts?.[0]?.verdict?.supported, false);
  assert.equal(state.messages.filter((message) => message.role === 'assistant').length, 0);
  const resumed = await agent.resume({ caseId: f.first.id, sessionId: state.id });
  assert.equal(active(resumed).status, 'failed'); assert.equal(active(resumed).usedModelCalls, 2);
  assert.match(active(resumed).error!, /AGENT_MODEL_BUDGET/); assert.equal(script.calls.length, 2);
  assert.equal(resumed.messages.filter((message) => message.role === 'assistant').length, 0);
});

test('cancellation during reply review cannot admit a late acceptance or trigger another correction call', async (t) => {
  const f = await fixture(t), controller = new AbortController();
  const script = fakeModel(() => ({ kind: 'reply', message: '我可以查看材料目录。', evidenceStepIds: [] }), { reviewReply: () => {
    controller.abort(); return { supported: true, necessary: true, reason: '此返回发生在取消之后。' };
  } });
  const agent = await f.create(script.model), state = await agent.send({ caseId: f.first.id, message: '介绍一下功能', signal: controller.signal });
  assert.equal(active(state).status, 'interrupted'); assert.equal(active(state).usedModelCalls, 2);
  assert.equal(state.messages.filter((message) => message.role === 'assistant').length, 0); assert.equal(script.calls.length, 2);
  assert.ok((active(state).replyAttempts ?? []).every((attempt) => attempt.verdict === null));
  const stored = await agent.read({ caseId: f.first.id, sessionId: state.id });
  assert.equal(stored.messages.filter((message) => message.role === 'assistant').length, 0);
});

test('two rejected reply attempts stay exhausted after restart while an explicit new user turn can begin a fresh reviewed task', async (t) => {
  const f = await fixture(t); let fixed = false;
  const script = fakeModel(() => ({ kind: 'reply', message: fixed ? '我可以帮助你查看案件和材料。' : '没有读取就断言当前案件没有材料。', evidenceStepIds: [] }),
    { reviewReply: () => ({ supported: fixed, necessary: true, reason: fixed ? '能力说明来自可信运行时。' : '没有材料目录查询结果，不能推断案件为空。' }) });
  const first = await (await f.create(script.model)).send({ caseId: f.first.id, message: '介绍一下你自己' });
  assert.equal(active(first).status, 'failed'); assert.equal(active(first).replyAttempts?.length, 2);
  assert.equal(active(first).usedModelCalls, 4); assert.equal(script.calls.length, 4);
  fixed = true;
  const restarted = await f.create(script.model), resumed = await restarted.resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(resumed).status, 'failed'); assert.match(active(resumed).error!, /AGENT_REPLY_REPAIR_LIMIT/);
  assert.equal(active(resumed).replyAttempts?.length, 2); assert.equal(script.calls.length, 4);
  assert.equal(resumed.messages.filter((message) => message.role === 'assistant').length, 0);
  const next = await restarted.send({ caseId: f.first.id, sessionId: first.id, message: '现在仅说明你具备的功能。' });
  assert.equal(active(next).status, 'completed'); assert.equal(active(next).parentTaskId, active(first).id);
  assert.equal(active(next).replyAttempts?.length, 1); assert.equal(active(next).usedModelCalls, 2);
  assert.equal(next.tasks[0]!.replyAttempts?.length, 2); assert.equal(script.calls.length, 6);
});

test('a review accepted before a lost checkpoint response resumes without repeating model calls or bypassing the saved verdict', async (t) => {
  const f = await fixture(t);
  const candidate = { kind: 'reply' as const, message: '我可以帮助你查看材料并生成带出处的底稿。', evidenceStepIds: [] };
  const script = fakeModel(() => candidate);
  const original = ExecutionStore.prototype.save; let lost = false;
  t.after(() => { ExecutionStore.prototype.save = original; });
  ExecutionStore.prototype.save = async function (input, options) {
    const committed = await original.call(this, input, options);
    const state = agentStateSchema.parse(input.payload), task = active(state);
    if (!lost && task.replyAttempts?.at(-1)?.verdict?.supported
      && !state.messages.some((message) => message.role === 'assistant' && message.taskId === task.id)) {
      lost = true; throw new Error('DEEPSEEK_NETWORK_ERROR: fixture lost response after saving an accepted reply verdict');
    }
    return committed;
  };
  const first = await (await f.create(script.model)).send({ caseId: f.first.id, message: '介绍一下你自己', limits: { maxModelCalls: 2 } });
  assert.equal(lost, true); assert.equal(active(first).status, 'interrupted'); assert.equal(script.calls.length, 2);
  assert.equal(first.messages.filter((message) => message.role === 'assistant').length, 0);
  ExecutionStore.prototype.save = original;
  const restarted = await f.create(script.model), beforeResume = await restarted.read({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(beforeResume).replyAttempts?.[0]?.verdict?.supported, true);
  assert.equal(beforeResume.messages.filter((message) => message.role === 'assistant').length, 0);
  const final = await restarted.resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(final).status, 'completed'); assert.equal(active(final).usedModelCalls, 2);
  assert.equal(active(final).replyAttempts?.length, 1); assert.equal(script.calls.length, 2);
  assert.deepEqual(final.messages.filter((message) => message.role === 'assistant').map((message) => message.text), [candidate.message]);
});

test('a necessary question waits for a new user message and the answer starts a linked task', async (t) => {
  const f = await fixture(t);
  const script = fakeModel((input) => input.task.goal.includes('补充') ? reply([]) : { kind: 'ask', message: '请补充本次要整理的材料。', reason: '目前尚无材料', evidenceStepIds: [] });
  const agent = await f.create(script.model), first = await agent.send({ caseId: f.first.id, message: '开始整理' });
  assert.equal(active(first).status, 'waiting_input'); const count = script.calls.length;
  assert.deepEqual(await agent.resume({ caseId: f.first.id, sessionId: first.id }), first); assert.equal(script.calls.length, count);
  const next = await agent.send({ caseId: f.first.id, sessionId: first.id, message: '补充：我稍后提供材料。' });
  assert.equal(active(next).status, 'completed'); assert.equal(active(next).parentTaskId, active(first).id);
});

test('supplementing materials after an interrupted read creates a child task and preserves the earlier task history', async (t) => {
  const f = await fixture(t), controller = new AbortController(); let firstRead = true;
  const tool = defineAgentTool({ id: 'test.case-count', version: 1, description: '读取当前材料数', effect: 'read', input: z.strictObject({}), inputSchema: { type: 'object' },
    execute: async () => { if (firstRead) { firstRead = false; controller.abort(); } return { count: (await f.workspace.contents(f.first.id)).materials.length }; } });
  const script = fakeModel((input) => current(input).length ? reply(current(input)) : invoke(tool.id));
  const first = await (await f.create(script.model, { tools: [tool] })).send({ caseId: f.first.id, message: '检查现有材料', signal: controller.signal });
  await f.workspace.registerText({ caseId: f.first.id, sourceLabel: '补充材料', text: '新收到的原话。' });
  const final = await (await f.create(script.model, { tools: [tool] })).resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(final).status, 'completed'); assert.equal(final.tasks.length, 2); assert.equal(final.tasks[0]!.status, 'superseded');
  assert.equal(active(final).parentTaskId, final.tasks[0]!.id); assert.deepEqual(final.steps.at(-1)!.result, { count: 1 });
  assert.equal(active(final).usedModelCalls, script.calls.length);
  assert.equal(active(final).usedSteps, active(first).usedSteps + 1);
});

test('the model receives failed-action feedback and can correct an invalid request after resume', async (t) => {
  const f = await fixture(t); let sawFailure = false;
  const script = fakeModel((input) => {
    const observed = current(input);
    if (observed.length > 0) return reply(observed);
    const failed = input.failedSteps?.find((step) => step.toolId === 'case.overview');
    if (failed) {
      assert.match(failed.error, /TOOL_INPUT_INVALID/); assert.deepEqual(failed.input, { invented: true }); sawFailure = true;
      return invoke('case.overview');
    }
    return invoke('case.overview', { invented: true });
  });
  const first = await (await f.create(script.model)).send({ caseId: f.first.id, message: '查看案件资料' });
  assert.equal(active(first).status, 'failed');
  const final = await (await f.create(script.model)).resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(sawFailure, true); assert.equal(active(final).status, 'completed');
  assert.deepEqual(final.steps.map((step) => step.status), ['failed', 'completed']);
});

test('an interrupted write without a reconciliation receipt is not blindly executed again', async (t) => {
  const f = await fixture(t); let executions = 0, checks = 0;
  const tool = defineAgentTool({ id: 'test.uncertain-write', version: 1, description: '未确认写入结果的夹具', effect: 'write',
    input: z.strictObject({}), inputSchema: { type: 'object' },
    execute: async () => { executions += 1; throw new Error('DEEPSEEK_NETWORK_ERROR: unknown write outcome'); },
    reconcile: async () => { checks += 1; return { status: 'unknown', reason: '先核查已发生的操作' }; } });
  const script = fakeModel(() => invoke(tool.id));
  const first = await (await f.create(script.model, { tools: [tool] })).send({ caseId: f.first.id, message: '执行这次写入' });
  assert.equal(active(first).status, 'interrupted');
  const resumed = await (await f.create(script.model, { tools: [tool] })).resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(resumed).status, 'failed'); assert.match(active(resumed).error!, /AGENT_WRITE_UNCERTAIN/);
  assert.equal(resumed.steps[0]!.status, 'uncertain'); assert.equal(executions, 1); assert.equal(checks, 1);
  assert.equal(active(resumed).usedModelCalls, active(first).usedModelCalls);
});

test('a new user message cannot abandon an unconfirmed write and duplicate its effects', async (t) => {
  const f = await fixture(t); let executions = 0;
  const tool = defineAgentTool({ id: 'test.pending-write', version: 1, description: '新消息前必须核查的写操作', effect: 'write',
    input: z.strictObject({}), inputSchema: { type: 'object' },
    execute: async () => { executions += 1; throw new Error('DEEPSEEK_NETWORK_ERROR: write confirmation was lost'); },
    reconcile: async () => ({ status: 'unknown', reason: '结果未知，不可重复写入' }) });
  const script = fakeModel(() => invoke(tool.id)), agent = await f.create(script.model, { tools: [tool] });
  const first = await agent.send({ caseId: f.first.id, message: '保存本次资料' });
  const calls = script.calls.length;
  await assert.rejects(agent.send({ caseId: f.first.id, sessionId: first.id, message: '再保存一遍' }), /AGENT_WRITE_UNCERTAIN/);
  const saved = await agent.read({ caseId: f.first.id, sessionId: first.id });
  assert.equal(saved.tasks.length, 1); assert.equal(saved.messages.filter((item) => item.role === 'user').length, 1);
  assert.equal(executions, 1); assert.equal(script.calls.length, calls);
});

test('new material after a completed analysis starts a linked run while retaining history and saved spending limits', async (t) => {
  const f = await fixture(t);
  await f.workspace.registerText({ caseId: f.first.id, sourceLabel: '来源A', text: paymentText(6000) });
  const script = fakeModel((input) => current(input).some((item) => item.toolId === 'information.organize')
    ? reply(current(input)) : invoke('information.organize', { profileId: profile.id, selections: [] }));
  const initialAgent = await f.create(script.model, { profiles: [profile] });
  const first = await initialAgent.send({ caseId: f.first.id, message: '核对现有付款材料', limits: { maxModelCalls: 40, maxSteps: 5 } });
  assert.equal(active(first).status, 'completed');
  const earlier = first.steps[0]!.result as { runId: string };
  await f.workspace.registerText({ caseId: f.first.id, sourceLabel: '来源B', text: paymentText(8000) });
  const final = await (await f.create(script.model, { profiles: [profile] })).resume({ caseId: f.first.id, sessionId: first.id });
  assert.equal(active(final).status, 'completed'); assert.equal(final.tasks.length, 2);
  assert.equal(active(final).parentTaskId, active(first).id); assert.equal(final.tasks[0]!.status, 'superseded');
  assert.deepEqual(active(final).limits, active(first).limits); assert.equal(active(final).usedSteps, 2);
  assert.equal(active(final).usedModelCalls, script.calls.length);
  const latest = final.steps.at(-1)!.result as { runId: string; findings: unknown[]; status: string };
  assert.notEqual(latest.runId, earlier.runId); assert.equal(latest.findings.length, 2); assert.equal(latest.status, 'needs_review');
  assert.equal((await new LoopRunStore(f.dataDir).read({ caseId: f.first.id, runId: earlier.runId })).findings.length, 1);
  assert.equal((await f.cases.readState(f.first.id)).workspace!.loopRuns!.length, 2);
});

test('the agent wires its actual organized run into versioned Markdown and Word outputs', async (t) => {
  const f = await fixture(t);
  await f.workspace.registerText({ caseId: f.first.id, sourceLabel: '付款凭证', text: paymentText(6000) });
  const script = fakeModel((input) => {
    const observed = current(input), organized = observed.find((item) => item.toolId === 'information.organize');
    if (!organized) return invoke('information.organize', { profileId: profile.id, selections: [] });
    if (!observed.some((item) => item.toolId === 'output.create')) return invoke('output.create', { runId: (organized.result as { runId: string }).runId });
    return reply(observed);
  });
  const state = await (await f.create(script.model, { profiles: [profile] })).send({ caseId: f.first.id, message: '整理这笔付款并生成底稿' });
  assert.equal(active(state).status, 'completed'); assert.deepEqual(state.steps.map((step) => step.toolId), ['information.organize', 'output.create']);
  const output = state.steps[1]!.result as { outputId: string; runId: string; paths: { json: string; md: string; docx: string }; currentInputMatches: boolean };
  const runId = (state.steps[0]!.result as { runId: string }).runId;
  assert.equal(output.runId, runId); assert.equal(output.currentInputMatches, true);
  assert.match(await readFile(output.paths.md, 'utf8'), /6000元/);
  assert.equal((await readFile(output.paths.docx)).subarray(0, 2).toString(), 'PK');
  const persisted = await readCaseOutput({ dataDir: f.dataDir, caseId: f.first.id, outputId: output.outputId });
  assert.equal(persisted.draft.references.length, 1); assert.equal(persisted.draft.findings.length, 1);
  assert.equal((await f.cases.readState(f.first.id)).workspace!.outputs!.length, 1);
});

test('ambiguous text branches produce actionable feedback and a necessary version-selection question', async (t) => {
  const f = await fixture(t);
  const material = await f.workspace.registerText({ caseId: f.first.id, sourceLabel: '待选择修订分支', text: paymentText(6000) });
  const base = await f.workspace.readVersion({ caseId: f.first.id, materialId: material.id, versionId: material.id });
  const branch = await f.workspace.saveRevision({ caseId: f.first.id, materialId: material.id,
    baseVersionId: material.id, baseTextSha256: base.version.textSha256, editor: '测试甲', text: paymentText(6000) });
  await f.workspace.saveRevision({ caseId: f.first.id, materialId: material.id,
    baseVersionId: material.id, baseTextSha256: base.version.textSha256, editor: '测试乙', text: paymentText(8000) });
  const script = fakeModel((input) => {
    if (input.task.goal.includes('选择甲')) return current(input).length ? reply(current(input))
      : invoke('information.organize', { profileId: profile.id, selections: [{ materialId: material.id, versionId: branch.id }] });
    const failed = input.failedSteps?.find((step) => step.toolId === 'information.organize');
    if (failed) {
      assert.match(failed.error, /AGENT_VERSION_SELECTION_REQUIRED/);
      return { kind: 'ask', message: '这份材料有两个修订分支，请指定使用甲还是乙。', reason: '存在两个有效分支，不能自动选择最新', evidenceStepIds: [] };
    }
    return invoke('information.organize', { profileId: profile.id, selections: [] });
  });
  const initial = await (await f.create(script.model, { profiles: [profile] })).send({ caseId: f.first.id, message: '整理材料' });
  assert.equal(active(initial).status, 'failed'); assert.equal(initial.steps[0]!.status, 'failed');
  const agent = await f.create(script.model, { profiles: [profile] });
  const question = await agent.resume({ caseId: f.first.id, sessionId: initial.id });
  assert.equal(active(question).status, 'waiting_input'); assert.equal(question.steps.length, 1);
  assert.equal(script.calls.filter((call) => call.kind === 'extract').length, 0);
  const final = await agent.send({ caseId: f.first.id, sessionId: initial.id, message: '选择甲分支，继续整理。' });
  assert.equal(active(final).status, 'completed');
  const result = final.steps.at(-1)!.result as { findings: { record: InformationRecord }[] };
  assert.equal(result.findings.length, 1); assert.equal(result.findings[0]!.record.value.normalized, '6000');
});

test('changed tool definitions block replay of a pending operation rather than silently using another implementation', async (t) => {
  const f = await fixture(t), controller = new AbortController();
  const tool = defineAgentTool({ id: 'test.versioned', version: 1, description: '旧版读取', effect: 'read', input: z.strictObject({}), inputSchema: { type: 'object' },
    execute: async () => { controller.abort(); return {}; } });
  const script = fakeModel(() => invoke(tool.id));
  const first = await (await f.create(script.model, { tools: [tool] })).send({ caseId: f.first.id, message: '运行旧版工具', signal: controller.signal });
  const changed = await f.create(script.model, { tools: [{ ...tool, version: 2, description: '新版工具' }] });
  await assert.rejects(changed.resume({ caseId: f.first.id, sessionId: first.id }), (error: unknown) => error instanceof AgentError && error.code === 'AGENT_ENVIRONMENT_CHANGED');
});

test('a case rollback while a write waits prevents the late side effect and cannot republish the removed session', async (t) => {
  const f = await fixture(t), rollback = new CaseRollback(f.cases, f.workspace);
  const checkpoint = await rollback.createCheckpoint({ caseId: f.first.id, label: '任务前', actor: '测试' });
  let entered!: () => void, proceed!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { proceed = resolve; });
  const tool = defineAgentTool({ id: 'test.late-write', version: 1, description: '检查迟到保存', effect: 'write', input: z.strictObject({}), inputSchema: { type: 'object' },
    execute: async (_, context) => { entered(); await gate; return f.workspace.registerText({ caseId: context.caseId, sourceLabel: '不应返回当前视图的迟到材料', text: '迟到数据' }, { expectedRevision: context.expectedCaseRevision! }); },
    reconcile: async () => ({ status: 'not_started' }) });
  const script = fakeModel(() => invoke(tool.id)), agent = await f.create(script.model, { tools: [tool] });
  const pending = agent.send({ caseId: f.first.id, message: '保存本次材料' }); await ready;
  const preview = await rollback.preview({ caseId: f.first.id, checkpointId: checkpoint.id });
  await rollback.apply({ caseId: f.first.id, checkpointId: checkpoint.id, expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '测试' });
  proceed(); const late = await pending;
  assert.equal(active(late).status, 'failed'); assert.equal((await f.workspace.contents(f.first.id)).materials.length, 0);
  await assert.rejects(agent.read({ caseId: f.first.id, sessionId: late.id }), /EXECUTION_NOT_ACTIVE/);
  assert.equal((await agent.sessions(f.first.id)).length, 0);
});
