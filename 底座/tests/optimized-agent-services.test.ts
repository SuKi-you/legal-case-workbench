import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { LegalAgent } from '../src/agent/engine.ts';
import { defineAgentTool, type AgentTool } from '../src/agent-tools/contracts.ts';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { organizeCaseInformation } from '../src/information/service.ts';
import { canonicalJson } from '../src/utils/canonical.ts';
import type { JsonModel } from '../src/information/model.ts';

const empty = z.strictObject({});
async function setup(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-optimized-services-'));
  const cases = new CaseStore(dataDir), record = await cases.create({ title: '仅用于服务隔离的虚构案件', actor: '自动验收' });
  const agents: LegalAgent[] = [];
  t.after(async () => {
    for (const agent of agents) await agent.close();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, caseId: record.id, create: async (model: JsonModel, tools: AgentTool[]) => {
    const agent = await LegalAgent.create({ dataDir, model, tools }); agents.push(agent); return agent;
  } };
}

test('plugin model requests use the same persisted model budget as planning and reply review', async (t) => {
  const f = await setup(t); let actual = 0, pluginCalls = 0;
  const model: JsonModel = { id: 'offline', model: 'budget', complete: async ({ system, user }) => {
    actual += 1;
    if (system === 'PLUGIN_REVIEW') { pluginCalls += 1; return { reviewed: true }; }
    if (system.includes('LEGAL_AGENT_REPLY_REVIEW')) return { supported: true, necessary: true, reason: '仅验证执行计数' };
    const input = JSON.parse(user) as { observations: { stepId: string }[] };
    return input.observations.length ? { kind: 'reply', message: '专业复核已执行。', evidenceStepIds: [input.observations[0]!.stepId] }
      : { kind: 'tool', toolId: 'test.professional', toolVersion: 1, arguments: {}, reason: '验证专业模型通道' };
  } };
  const tool = defineAgentTool({ id: 'test.professional', version: 1, effect: 'read', description: '仅离线测试专业模型调用',
    input: empty, inputSchema: { type: 'object', properties: {} }, execute: async (_, context) => {
      assert.ok(context.services); return context.services.model.complete({ system: 'PLUGIN_REVIEW', user: '{}' });
    } });
  const agent = await f.create(model, [tool]);
  const state = await agent.send({ caseId: f.caseId, message: '执行专业复核', limits: { maxModelCalls: 3 } });
  const task = state.tasks.at(-1)!;
  assert.equal(task.usedModelCalls, 3); assert.equal(actual, 3); assert.equal(pluginCalls, 1);
  assert.equal(task.status, 'failed'); assert.match(task.error!, /AGENT_MODEL_BUDGET/u);
  assert.equal(state.steps[0]!.status, 'completed');
});

test('plugin cancellation reaches the actual model request and cannot publish a late result', async (t) => {
  const f = await setup(t), controller = new AbortController(); let cancelled = false;
  const model: JsonModel = { id: 'offline', model: 'cancel', complete: async ({ system, signal }) => {
    if (system === 'PLUGIN_WAIT') return new Promise((_resolve, reject) => {
      assert.ok(signal);
      signal.addEventListener('abort', () => { cancelled = true; reject(new Error('PLUGIN_CANCELLED')); }, { once: true });
      setTimeout(() => controller.abort(), 5);
    });
    return { kind: 'tool', toolId: 'test.wait', toolVersion: 1, arguments: {}, reason: '验证取消传播' };
  } };
  const tool = defineAgentTool({ id: 'test.wait', version: 1, effect: 'read', description: '等待取消', input: empty,
    inputSchema: { type: 'object', properties: {} }, execute: (_, context) => context.services!.model.complete({ system: 'PLUGIN_WAIT', user: '{}' }) });
  const state = await (await f.create(model, [tool])).send({ caseId: f.caseId, message: '验证取消', signal: controller.signal });
  assert.equal(cancelled, true); assert.equal(state.tasks.at(-1)!.status, 'interrupted');
  assert.equal(state.steps.some((step) => step.status === 'completed'), false);
});

test('property ordering cannot bypass repeated-action protection', async (t) => {
  const f = await setup(t); let executions = 0, plans = 0;
  const input = z.strictObject({ a: z.number(), b: z.number() });
  const tool = defineAgentTool({ id: 'test.echo', version: 1, effect: 'read', description: '稳定动作身份', input,
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
    execute: async (value) => { executions += 1; return value; } });
  const model: JsonModel = { id: 'offline', model: 'keys', complete: async () => ({ kind: 'tool', toolId: 'test.echo', toolVersion: 1,
    arguments: ++plans === 1 ? { a: 1, b: 2 } : { b: 2, a: 1 }, reason: '验证相同动作不会重复执行' }) };
  const state = await (await f.create(model, [tool])).send({ caseId: f.caseId, message: '验证重复保护' });
  assert.equal(executions, 1); assert.match(state.tasks.at(-1)!.error!, /AGENT_REPEATED_ACTION/u);
  assert.equal(canonicalJson({ a: { c: 3, b: 2 } }), canonicalJson({ a: { b: 2, c: 3 } }));
});

test('a plugin cannot use another case run ID through its bound run service', async (t) => {
  const f = await setup(t), cases = new CaseStore(f.dataDir), workspace = new CaseWorkspace(f.dataDir, cases);
  const other = await cases.create({ title: '另一个独立虚构案件', actor: '自动验收' });
  const material = await workspace.registerText({ caseId: other.id, sourceLabel: '另一案材料', text: '本记录只属于另一个案件。' });
  const otherRun = await organizeCaseInformation({ dataDir: f.dataDir, caseId: other.id,
    model: { id: 'offline', model: 'empty', complete: async () => ({ items: [] }) },
    plan: { goal: '仅检验案例隔离', selections: [{ materialId: material.id, versionId: material.id }], needs: [{ id: 'test.scope',
      question: '材料记载了什么？', reason: '隔离检查', spec: { topic: 'scope', subject: null, object: null, period: null,
        basis: null, requiredFields: [], minimumSupport: 'statement', applicable: true } }] } });
  const tool = defineAgentTool({ id: 'test.foreign-run', version: 1, effect: 'read', description: '尝试读取另一案ID', input: empty,
    inputSchema: { type: 'object', properties: {} }, execute: (_, context) => context.services!.runs.read(otherRun.id) });
  const model: JsonModel = { id: 'offline', model: 'scope', complete: async () => ({ kind: 'tool', toolId: 'test.foreign-run', toolVersion: 1,
    arguments: {}, reason: '验证跨案读取被拒绝' }) };
  const state = await (await f.create(model, [tool])).send({ caseId: f.caseId, message: '验证插件案件隔离' });
  assert.equal(state.tasks.at(-1)!.status, 'failed'); assert.match(state.tasks.at(-1)!.error!, /LOOP_RUN_NOT_ACTIVE/u);
  assert.equal(state.steps.some(step => step.status === 'completed'), false);
});

test('large tool observations remain durable without permanently overflowing the planner context', async (t) => {
  const f = await setup(t), large = '虚构记录'.repeat(60_000); let omitted = false;
  const tool = defineAgentTool({ id: 'test.large', version: 1, effect: 'read', description: '大型离线工具结果', input: empty,
    inputSchema: { type: 'object', properties: {} }, execute: async () => ({ body: large }) });
  const model: JsonModel = { id: 'offline', model: 'large', complete: async ({ system, user }) => {
    if (system.includes('LEGAL_AGENT_REPLY_REVIEW')) return { supported: true, necessary: true, reason: '仅陈述保存状态，不引用省略正文' };
    const input = JSON.parse(user) as { observations: { stepId: string; result: { omittedFromModelContext?: boolean } }[] };
    if (input.observations.length) {
      omitted = input.observations[0]!.result.omittedFromModelContext === true;
      return { kind: 'reply', message: '结果已保存；完整正文未进入本次模型视图。', evidenceStepIds: [input.observations[0]!.stepId] };
    }
    return { kind: 'tool', toolId: 'test.large', toolVersion: 1, arguments: {}, reason: '验证大结果保存与规划分离' };
  } };
  const agent = await f.create(model, [tool]);
  const state = await agent.send({ caseId: f.caseId, message: '检查大型结果' });
  assert.equal(state.tasks.at(-1)!.status, 'completed'); assert.equal(omitted, true);
  assert.equal((state.steps[0]!.result as { body: string }).body, large);
  const restored = await agent.read({ caseId: f.caseId, sessionId: state.id });
  assert.equal((restored.steps[0]!.result as { body: string }).body, large);
});

test('a completed write cannot relabel an earlier result as covering concurrent case inputs', async (t) => {
  const f = await setup(t), workspace = new CaseWorkspace(f.dataDir);
  let sawHistoricalScope = false;
  const writer = defineAgentTool({ id: 'test.snapshot-write', version: 1, effect: 'write', description: '写入后返回当时的范围', input: empty,
    inputSchema: { type: 'object', properties: {} }, execute: async (_, context) => {
      await workspace.registerText({ caseId: context.caseId, sourceLabel: '操作自己的材料', text: '材料A' });
      const result = { materialCount: (await workspace.contents(context.caseId)).materials.length };
      // Another writer publishes a new input after this result was computed.
      await workspace.registerText({ caseId: context.caseId, sourceLabel: '另一写入者的材料', text: '材料B' });
      return result;
    } });
  const model: JsonModel = { id: 'offline', model: 'write-scope', complete: async ({ system, user }) => {
    if (system.includes('LEGAL_AGENT_REPLY_REVIEW')) return { supported: true, necessary: true, reason: '当前数量来自后续目录查询' };
    const input = JSON.parse(user) as { observations: { stepId: string; toolId: string; currentInput: boolean; result: { materialCount?: number; materials?: unknown[] } }[] };
    const written = input.observations.find(item => item.toolId === 'test.snapshot-write');
    const listed = input.observations.find(item => item.toolId === 'case.materials');
    if (listed) return { kind: 'reply', message: `当前目录有${listed.result.materials!.length}份材料。`, evidenceStepIds: [listed.stepId] };
    if (written) {
      assert.equal(written.result.materialCount, 1); assert.equal(written.currentInput, false); sawHistoricalScope = true;
      return { kind: 'tool', toolId: 'case.materials', toolVersion: 1, arguments: {}, reason: '重新确认已经变化的范围' };
    }
    return { kind: 'tool', toolId: 'test.snapshot-write', toolVersion: 1, arguments: {}, reason: '检查写入时的范围归属' };
  } };
  const state = await (await f.create(model, [writer])).send({ caseId: f.caseId, message: '检查当前材料数量' });
  assert.equal(sawHistoricalScope, true); assert.equal(state.tasks.at(-1)!.status, 'completed');
  assert.equal(state.messages.at(-1)!.text, '当前目录有2份材料。');
});
