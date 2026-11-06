/**
 * 工具测试：走底座的 AgentToolCatalog（含输入校验），而不是直接调内部函数。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentToolCatalog } from '../../底座/src/agent-tools/catalog.ts';
import type { AgentToolContext } from '../../底座/src/agent-tools/contracts.ts';
import { LABOR_NEEDS } from '../src/labor/elements.ts';
import { buildLaborKnowledge } from '../src/labor/issues.ts';
import { createLaborTools } from '../src/tools.ts';
import { TERMINATION_RUN, WAGE_GAP_RUN } from './fixtures/runs.ts';

const knowledge = buildLaborKnowledge();
const context: AgentToolContext = {
  caseId: WAGE_GAP_RUN.caseId,
  operationId: '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b90',
  userMessage: '看一下材料里缺了什么',
  expectedCaseRevision: 1,
};

const tools = createLaborTools({
  knowledge,
  needs: LABOR_NEEDS,
  loadRun: async (_caseId, runId) => {
    if (runId === WAGE_GAP_RUN.id) return WAGE_GAP_RUN;
    if (runId === TERMINATION_RUN.id) return TERMINATION_RUN;
    throw new Error(`测试没有这个运行：${runId}`);
  },
});
const catalog = new AgentToolCatalog(tools);

const run = (id: string, input: unknown): Promise<unknown> => catalog.execute({ id, version: 1 }, input, context);

interface ChecklistOut {
  domain: string;
  stance: string;
  issues: { issueId: string; title: string; elementCount: number; criticalCount: number; elements?: { elementId: string; burden: string }[] }[];
  needs?: { id: string; question: string }[];
}
interface AssessOut {
  issues: { issueId: string; state: string; reason: string }[];
  elements: { elementId: string; state: string }[];
  gapCount: number;
  warnings: string[];
}
interface GapsOut {
  total: number;
  gaps: { elementId: string; kind: string; consequence: string; action: string; detail?: string }[];
  checks: { checkId: string; severity: string }[];
  proofTasks: { id: string; goal: string; standard: string; burden: string }[];
}
interface AmountOut { value: Record<string, number | boolean>; formula: string; assumptions: string[]; verified: boolean; note: string }
interface DeadlineOut { value: { status: string; deadline: string | null; daysLeft: number | null } }

test('checklist 只列争点时足够轻', async () => {
  const out = await run('labor.checklist', {}) as ChecklistOut;
  assert.equal(out.domain, '劳动法');
  assert.equal(out.stance, 'claimant');
  assert.equal(out.issues.length, 5);
  const wage = out.issues.find((issue) => issue.issueId === 'labor.wage');
  assert.ok(wage && wage.elementCount >= 5 && wage.criticalCount >= 2);
  assert.equal(wage.elements, undefined, 'summary 模式不应包含要件明细');
});

test('checklist 可取要件与需求明细，也可只取一个争点', async () => {
  const detailed = await run('labor.checklist', { include: 'elements' }) as ChecklistOut;
  const wage = detailed.issues.find((issue) => issue.issueId === 'labor.wage');
  assert.ok(wage?.elements && wage.elements.length >= 5);
  assert.ok(wage.elements.some((element) => element.burden === 'respondent'));

  const needs = await run('labor.checklist', { include: 'needs' }) as ChecklistOut;
  assert.ok((needs.needs?.length ?? 0) > 0);
  assert.ok(needs.needs?.every((need) => need.id.startsWith('labor.need.')));

  const single = await run('labor.checklist', { issueId: 'labor.termination' }) as ChecklistOut;
  assert.equal(single.issues.length, 1);
  assert.equal(single.issues[0]?.issueId, 'labor.termination');

  await assert.rejects(run('labor.checklist', { issueId: 'labor.nope' }), /没有这个争点/u);
});

test('assess 输出争点状态与要件明细', async () => {
  const out = await run('labor.assess', { runId: WAGE_GAP_RUN.id }) as AssessOut;
  assert.equal(out.issues.find((issue) => issue.issueId === 'labor.wage')?.state, 'judgeable');
  assert.equal(out.issues.find((issue) => issue.issueId === 'labor.termination')?.state, 'insufficient');
  assert.equal(out.elements.length, 29);
  assert.ok(out.gapCount > 0);
  assert.ok(out.warnings.length > 0);
});

test('assess 支持切换视角，且不改变争点状态', async () => {
  const claimant = await run('labor.assess', { runId: TERMINATION_RUN.id, stance: 'claimant' }) as AssessOut;
  const respondent = await run('labor.assess', { runId: TERMINATION_RUN.id, stance: 'respondent' }) as AssessOut;
  assert.equal(
    claimant.issues.find((issue) => issue.issueId === 'labor.termination')?.state,
    respondent.issues.find((issue) => issue.issueId === 'labor.termination')?.state,
  );
});

test('gaps 是"没有材料"的唯一出口，含缺失月份、校验与证明任务', async () => {
  const out = await run('labor.gaps', { runId: WAGE_GAP_RUN.id }) as GapsOut;
  assert.ok(out.total > 0);
  const missing = out.gaps.find((gap) => gap.kind === 'missing_period');
  assert.ok(missing, '应报出缺失月份');
  assert.match(missing.detail ?? '', /2024-06/u);
  for (const gap of out.gaps) {
    assert.ok(gap.consequence.length > 0 && gap.action.length > 0);
  }

  assert.equal(out.proofTasks.length, out.total, '每条缺口一个证明任务');
  const monthTask = out.proofTasks.find((task) => task.goal.includes('2024-06'));
  assert.ok(monthTask);
  assert.equal(monthTask.standard, '要求书证');
  assert.ok(out.checks.some((check) => check.checkId === 'labor.check.wage-gap-month'));
});

test('金额测算：多条路径分别测算，不自动择一', async () => {
  const severanceResult = await run('labor.amount', { path: 'severance', monthlyWage: 8_000, totalMonths: 39 }) as AmountOut;
  assert.equal(severanceResult.value.months, 3.5);
  assert.equal(severanceResult.value.amount, 28_000);
  assert.equal(severanceResult.verified, false);
  assert.match(severanceResult.note, /未核验/u);

  const illegal = await run('labor.amount', { path: 'illegal-termination', monthlyWage: 8_000, totalMonths: 39 }) as AmountOut;
  assert.equal(illegal.value.amount, 56_000);

  const double = await run('labor.amount', { path: 'double-wage', monthlyWage: 6_000, unsignedMonths: 15 }) as AmountOut;
  assert.equal(double.value.months, 11);
  assert.equal(double.value.amount, 66_000);

  const overtime = await run('labor.amount', { path: 'overtime', monthlyWage: 8_000, weekdayHours: 8 }) as AmountOut;
  assert.equal(overtime.value.amount, 551.72);

  await assert.rejects(run('labor.amount', { path: 'severance', monthlyWage: 8_000 }), /totalMonths/u);
});

test('时效测算：给出起算日与基准日即可判断', async () => {
  const out = await run('labor.deadline', {
    from: '2025-01-01', today: '2025-12-01', kind: 'other', relationOngoing: false,
  }) as DeadlineOut;
  assert.equal(out.value.status, 'expiring');
  assert.equal(out.value.deadline, '2026-01-01');
  assert.equal(out.value.daysLeft, 31);
});

test('底座的输入校验会拦住非法参数', async () => {
  await assert.rejects(run('labor.assess', {}), /TOOL_INPUT_INVALID|缺少必填字段/u);
  await assert.rejects(run('labor.amount', { path: '不存在的路径', monthlyWage: 1 }), /TOOL_INPUT_INVALID|之一/u);
  await assert.rejects(run('labor.assess', { runId: 'not-a-uuid' }), /LABOR_INPUT_INVALID|UUID/u);
});

interface PathsOut {
  total: number;
  paths: { pathId: string; state: string; stateLabel: string; outcome: string; calc?: { tool: string; path: string } }[];
}
interface DefensesOut {
  total: number;
  active: number;
  dormant: number;
  defenses: { defenseId: string; state: string; effect: string; signals: string[]; response: string[] }[];
}

test('paths 工具：三条路径并列，给出测算入口但不择高', async () => {
  const out = await run('labor.paths', { runId: TERMINATION_RUN.id }) as PathsOut;
  assert.equal(out.total, 3);
  const available = out.paths.filter((path) => path.state === 'available');
  assert.equal(available.length, 1, '只有"单位作出解除"要件齐备');
  assert.equal(available[0]?.calc?.path, 'illegal-termination');
  assert.ok(out.paths.every((path) => path.stateLabel.length > 0));
});

test('defenses 工具：只列可能命中的抗辩，并附我方应对材料', async () => {
  const out = await run('labor.defenses', { runId: TERMINATION_RUN.id }) as DefensesOut;
  assert.equal(out.total, 7);
  assert.equal(out.active, 0, '日期及无管理记载不自动触发时效或劳务抗辩');
  assert.equal(out.dormant, 7);
  for (const defense of out.defenses) {
    assert.ok(defense.response.length > 0, `抗辩必须给出应对材料：${defense.defenseId}`);
    assert.ok(['block', 'reduce', 'shift_burden'].includes(defense.effect));
  }
  assert.ok(out.defenses.every((defense) => defense.defenseId !== 'labor.defense.service'));
});

test('opinions 工具：未注入模型时优雅退化，列出待人工判断的要件', async () => {
  const out = await run('labor.opinions', { runId: TERMINATION_RUN.id }) as {
    enabled: boolean;
    reason: string;
    pending?: { elementId: string; question: string; factors: string[]; state: string }[];
  };
  assert.equal(out.enabled, false);
  assert.match(out.reason, /未注入模型/u);
  assert.equal(out.pending?.length, 2);
  for (const item of out.pending ?? []) {
    assert.ok(item.question.length > 0);
    assert.ok(item.factors.length > 0);
  }
});

test('opinions 工具：注入模型后给出倾向与可核对引用，且不改变要件状态', async () => {
  let calls = 0;
  const firstFinding = TERMINATION_RUN.findings[0]!;
  const fake = {
    id: 'test-provider', model: 'fake-opinion-1',
    async complete(): Promise<unknown> {
      calls += 1;
      return {
        opinions: (knowledge.opinions ?? []).map((spec) => ({
          elementId: spec.elementId,
          tendency: 'unclear',
          confidence: 'low',
          reasoning: '现有材料不足以支持任何一方。',
          citations: [{ findingId: firstFinding.id, quote: firstFinding.statement.slice(0, 8) }],
          missingFactors: ['规章制度是否公示'],
        })),
      };
    },
  };
  const withModel = new AgentToolCatalog(createLaborTools({
    knowledge, needs: LABOR_NEEDS, model: fake,
    loadRun: async () => TERMINATION_RUN,
  }));

  const before = await catalog.execute({ id: 'labor.assess', version: 1 }, { runId: TERMINATION_RUN.id }, context) as { elements: { elementId: string; state: string }[] };
  const out = await withModel.execute({ id: 'labor.opinions', version: 1 }, { runId: TERMINATION_RUN.id }, context) as {
    enabled: boolean; count: number; inputDigest: string;
    opinions: { elementId: string; tendencyLabel: string; materialState: string; citations: { findingId: string; quote: string }[] }[];
  };
  const after = await catalog.execute({ id: 'labor.assess', version: 1 }, { runId: TERMINATION_RUN.id }, context) as { elements: { elementId: string; state: string }[] };

  assert.equal(calls, 1, '一次评估只调一次模型');
  assert.equal(out.enabled, true);
  assert.equal(out.count, 2);
  assert.match(out.inputDigest, /^[0-9a-f]{64}$/u);
  for (const opinion of out.opinions) {
    assert.ok(opinion.tendencyLabel.length > 0);
    assert.ok(opinion.citations.length > 0, '每条意见都必须有可核对引用');
  }
  assert.deepEqual(after.elements.map((element) => element.state), before.elements.map((element) => element.state), '意见不改变要件状态');
});

test('只读工具的对账语义是 not_started，不会被误当成写操作重放', async () => {
  const result = await catalog.reconcile({ id: 'labor.assess', version: 1 }, { runId: WAGE_GAP_RUN.id }, context);
  assert.deepEqual(result, { status: 'not_started' });
});
