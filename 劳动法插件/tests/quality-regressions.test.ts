import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRun, stateFromCoverage } from '../src/kernel/assess.ts';
import { restrictKnowledge } from '../src/kernel/restrict.ts';
import { parseOpinions, buildOpinionRequest, evaluateOpinions } from '../src/kernel/opinion.ts';
import { buildLaborKnowledge } from '../src/labor/issues.ts';
import { LABOR_NEEDS } from '../src/labor/elements.ts';
import { noticePay, segmentedSeverance, doubleWage, PLACEHOLDER_PARAMS } from '../src/labor/calc.ts';
import { createProfessionalReviewer } from '../src/review.ts';
import { createLaborTools } from '../src/tools.ts';
import { TERMINATION_RUN } from './fixtures/runs.ts';
import type { DomainKnowledge } from '../src/kernel/contracts.ts';
import type { ProfessionalReviewInput } from '../src/base.ts';
import { validateProfessionalReview } from '../../底座/src/information/professional.ts';

const knowledge = buildLaborKnowledge();
const params = { ...PLACEHOLDER_PARAMS, averageMonthlyWage: 10000, verified: true };
function denial() {
  const run = structuredClone(TERMINATION_RUN);
  const finding = run.findings.find((item) => item.needId === 'labor.need.term.by-employer')!;
  finding.record!.polarity = 'denied'; finding.statement = '公司明确没有作出解除通知';
  const coverage = run.information!.needs.find((item) => item.needId === finding.needId)!;
  coverage.coverage = 'found'; coverage.support = 'document_supported'; coverage.satisfaction = 'satisfied';
  return run;
}

test('明确否定通知解除的书证不满足正向单位解除条件', () => {
  const assessment = assessRun(knowledge, denial());
  const origin = assessment.elements.find((item) => item.elementId === 'labor.termination.by-employer')!;
  assert.equal(origin.informationState, 'satisfied');
  assert.equal(origin.state, 'opposed');
  assert.notEqual(assessment.paths.find((item) => item.pathId === 'labor.path.unilateral')?.state, 'available');
});

test('有文书但语义待核、还有未读或缺字段时不升级为满足', () => {
  for (const extra of [{ consistency: 'ambiguous' }, { satisfaction: 'needs_review' }, { unread: [{}] }, { missingFields: ['time'] }]) {
    assert.equal(stateFromCoverage({ needId: 'n', coverage: 'found', support: 'document_supported', ...extra }), 'needs_review');
  }
});

test('一般解除理由不同时触发严重违纪及不能胜任的事实齐备', () => {
  const run = structuredClone(TERMINATION_RUN);
  const finding = structuredClone(run.findings[0]!); finding.id = 'b71a0500-8787-4d1a-b64c-821c57e04566';
  finding.needId = 'labor.need.term-reason'; finding.statement = '公司因经营困难要求离职';
  finding.record!.polarity = 'affirmed'; finding.record!.value = { kind: 'text', raw: '经营困难', normalized: '经营困难', unit: null };
  run.findings.push(finding);
  const coverage = run.information!.needs.find((item) => item.needId === finding.needId)!;
  Object.assign(coverage, { coverage: 'found', support: 'document_supported', satisfaction: 'satisfied', findingIds: [finding.id] });
  const out = assessRun(knowledge, run);
  for (const id of ['labor.defense.misconduct', 'labor.defense.incompetence']) assert.equal(out.defenses.find((item) => item.defenseId === id)?.state, 'unlikely');
  assert.notEqual(out.paths.find((item) => item.pathId === 'labor.path.unilateral')?.state, 'blocked');
});

test('普通通知与劳动管理无需原文事件编号才能保留完整回答', () => {
  for (const id of ['labor.need.term.by-employer', 'labor.need.term-form', 'labor.need.subordination']) {
    assert.equal(LABOR_NEEDS.find((item) => item.id === id)?.spec?.requiredFields.includes('event.key'), false);
  }
});

test('缺少主体等核心信息时不能只靠其他字段宣布可判断', () => {
  const run = structuredClone(TERMINATION_RUN);
  const out = assessRun(knowledge, run);
  assert.equal(out.issues.find((item) => item.issueId === 'labor.relationship')?.state, 'insufficient');
});

test('同一要件部分需求缺覆盖记录时保留未读', () => {
  const k: DomainKnowledge = { ...knowledge, elements: knowledge.elements.map((element) => element.id === 'labor.termination.by-employer' ? { ...element, needs: [...element.needs, 'not-read'] } : element) };
  assert.equal(assessRun(k, TERMINATION_RUN).elements.find((item) => item.elementId === 'labor.termination.by-employer')?.state, 'unread');
});

test('争点裁剪不得把 A 且 B 的抗辩悄悄改成只有 A', () => {
  const full: DomainKnowledge = { ...knowledge, defenses: [{ id: 'mixed', name: '跨争点检查', against: ['labor.termination'],
    requires: [{ elementId: 'labor.termination.date', in: ['satisfied'] }, { elementId: 'labor.wage.payment', in: ['satisfied'] }],
    effect: 'block', response: ['核对'], statute: [], reason: '两个条件缺一不可' }] };
  assert.equal(restrictKnowledge(full, ['labor.termination']).defenses?.some((item) => item.id === 'mixed'), false);
});

test('模型归纳不可以冒充原文引用', () => {
  const run = structuredClone(TERMINATION_RUN); const finding = run.findings[0]!;
  finding.statement = '这是模型总结而非材料原句';
  const specs = knowledge.opinions!.slice(0, 1);
  assert.throws(() => parseOpinions({ opinions: [{ elementId: specs[0]!.elementId, tendency: 'unclear', confidence: 'low',
    reasoning: '缺乏依据', citations: [{ findingId: finding.id, quote: finding.statement }], missingFactors: [] }] },
    { specs, run, states: new Map(specs.map((spec) => [spec.elementId, 'statement_only' as const])) }), /OPINION_QUOTE_INVALID/);
});

test('超过单次评价范围明确拒绝，不静默只取前60条', () => {
  const run = { ...TERMINATION_RUN, findings: Array.from({ length: 61 }, (_, index) => ({ ...TERMINATION_RUN.findings[0]!, id: String(index) })) };
  assert.throws(() => buildOpinionRequest({ specs: knowledge.opinions!, run, states: new Map() }), /OPINION_SCOPE_LIMIT/);
});

test('评价模型收到取消信号后不得发布迟到意见', async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(evaluateOpinions({ specs: knowledge.opinions!, run: TERMINATION_RUN, states: new Map() },
    { id: 'test', model: 'test', complete: async () => { called = true; return {}; } }, { signal: controller.signal }), /OPINION_CANCELLED/);
  assert.equal(called, false);
});

test('代通知金使用上月工资，不套三倍社平封顶', () => {
  const result = noticePay(50000, params);
  assert.equal(result.value.amount, 50000);
  assert.equal(result.inputs.lastMonthWage, 50000);
  assert.equal(result.applicabilityVerified, false);
});

test('经济补偿保留不足整月和整年后的零头', () => {
  assert.equal(segmentedSeverance(6000, '2026-10-01', '2026-10-02', params).value.total, 3000);
  assert.equal(segmentedSeverance(6000, '2025-10-01', '2026-10-02', params).value.total, 9000);
  assert.equal(segmentedSeverance(6000, '2025-10-01', '2026-10-01', params).value.total, 6000);
});

test('二倍工资零头按实际工作日与明确日工资，不猜小数月', () => {
  assert.throws(() => doubleWage(6000, 1.5, params), /实际工作日/);
  assert.equal(doubleWage(6000, 2, params, { workDays: 3, dailyWage: 200 }).value.amount, 12600);
});

test('跨2008分段即使参数核验也保留历史适用未核状态', () => {
  const result = segmentedSeverance(6000, '2007-01-01', '2026-01-01', params);
  assert.equal(result.verified, false); assert.equal(result.parametersVerified, true);
});

test('专业检查与通用覆盖分别保留，反向记录可回溯', async () => {
  const run = denial(); const input: ProfessionalReviewInput = { caseId: run.caseId, goal: run.goal, needs: [...LABOR_NEEDS], findings: run.findings,
    sources: run.sources, analysis: run.information!, attempts: [] };
  const before = JSON.stringify(input.analysis);
  const review = await createProfessionalReviewer(knowledge).review(input);
  validateProfessionalReview(review, input);
  assert.equal(review.assessments.find((item) => item.checkId === 'labor.termination.by-employer')?.state, 'opposed');
  assert.equal(JSON.stringify(input.analysis), before);
});

test('已知单位作出通知时不为完全无记录的另两种提出方重复提问', async () => {
  const run = TERMINATION_RUN; const input: ProfessionalReviewInput = { caseId: run.caseId, goal: run.goal, needs: [...LABOR_NEEDS], findings: run.findings,
    sources: run.sources, analysis: run.information!, attempts: [] };
  const review = await createProfessionalReviewer(knowledge).review(input);
  assert.equal(review.actions.some((item) => ['labor.need.term.by-employee', 'labor.need.term.by-agreement'].includes(item.needId)), false);
});

test('工具使用底座注入的案件读取和模型服务', async () => {
  let reads = 0; let models = 0; let oldReads = 0;
  const tool = createLaborTools({ knowledge, loadRun: async () => { oldReads++; throw new Error('不应调用旧读取器'); } }).find((item) => item.id === 'labor.opinions')!;
  const result = await tool.execute({ runId: TERMINATION_RUN.id }, {
    caseId: TERMINATION_RUN.caseId, operationId: 'ff27e292-70f7-4504-bfa4-361541db98fe', userMessage: '核对',
    services: { runs: { read: async () => { reads++; return TERMINATION_RUN; } }, model: {
      id: 'managed', model: 'managed', complete: async () => { models++; return { opinions: knowledge.opinions!.map((spec) => ({ elementId: spec.elementId,
        tendency: 'unclear', confidence: 'low', reasoning: '记录不足', citations: [{ findingId: TERMINATION_RUN.findings[0]!.id,
          quote: TERMINATION_RUN.findings[0]!.citations[0]!.quote }], missingFactors: ['需律师核对'] })) }; },
    } },
  }) as { enabled: boolean };
  assert.equal(result.enabled, true); assert.equal(reads, 1); assert.equal(models, 1); assert.equal(oldReads, 0);
});


test('明确布尔false不被视作肯定命题，也不重复反转否定', () => {
  const run = denial(); const finding = run.findings.find((item) => item.needId === 'labor.need.term.by-employer')!;
  finding.record!.polarity = 'affirmed'; finding.record!.value = { kind: 'boolean', raw: '否', normalized: 'false', unit: null };
  assert.equal(assessRun(knowledge, run).elements.find((item) => item.elementId === 'labor.termination.by-employer')?.state, 'opposed');
});


test('缺少评价性材料时即便引用存在也不能给强倾向', () => {
  const specs = knowledge.opinions!.slice(0, 1); const finding = TERMINATION_RUN.findings[0]!;
  assert.throws(() => parseOpinions({ opinions: [{ elementId: specs[0]!.elementId, tendency: 'likely', confidence: 'high', reasoning: '跳跃判断',
    citations: [{ findingId: finding.id, quote: finding.citations[0]!.quote }], missingFactors: [] }] },
    { specs, run: TERMINATION_RUN, states: new Map([[specs[0]!.elementId, 'absent']]) }), /unclear\/low/);
});


test('正向控制：实际记录违纪主张仍保留候选抗辩，不一律拒绝', () => {
  const run = structuredClone(TERMINATION_RUN); const finding = structuredClone(run.findings[0]!);
  finding.id = 'efa77d9c-23c1-4ab6-9679-eb7ff2db143d'; finding.needId = 'labor.need.term-reason';
  finding.statement = '公司以严重违纪为由通知解除'; finding.record!.polarity = 'affirmed';
  finding.record!.value = { kind: 'text', raw: '严重违纪', normalized: '严重违纪', unit: null }; run.findings.push(finding);
  Object.assign(run.information!.needs.find((item) => item.needId === finding.needId)!, { coverage: 'found', support: 'statement_only', satisfaction: 'satisfied', findingIds: [finding.id] });
  const out = assessRun(knowledge, run);
  assert.equal(out.defenses.find((item) => item.defenseId === 'labor.defense.misconduct')?.state, 'possible');
  assert.equal(out.defenses.find((item) => item.defenseId === 'labor.defense.incompetence')?.state, 'unlikely');
  assert.notEqual(out.paths.find((item) => item.pathId === 'labor.path.unilateral')?.state, 'blocked');
});
