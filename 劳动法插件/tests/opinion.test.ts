/**
 * 评价性要件的模型评估：结构、校验与"不改变判定"的边界。
 *
 * 这些测试不联网：模型用桩替代，只验证"我们要求模型做什么"和"我们接受什么输出"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpinionRequest, evaluateOpinions, OpinionError, parseOpinions } from '../src/kernel/opinion.ts';
import { assessRun } from '../src/kernel/assess.ts';
import { buildLaborKnowledge } from '../src/labor/issues.ts';
import { TERMINATION_RUN } from './fixtures/runs.ts';

const knowledge = buildLaborKnowledge();
const specs = knowledge.opinions ?? [];
const states = new Map(assessRun(knowledge, TERMINATION_RUN).elements.map((element) => [element.elementId, element.state]));

const firstFinding = TERMINATION_RUN.findings[0]!;
const supportedQuote = firstFinding.citations[0]!.quote;

function output(tendency = 'unclear'): { opinions: Record<string, unknown>[] } {
  return {
    opinions: specs.map((spec) => ({
      elementId: spec.elementId,
      tendency,
      confidence: 'low',
      reasoning: '现有材料不足以支持任何一方。',
      citations: [{ findingId: firstFinding.id, quote: supportedQuote }],
      missingFactors: ['规章制度是否公示'],
    })),
  };
}

const input = () => ({ specs, run: TERMINATION_RUN, states });

test('提问模板：一次调用覆盖全部评价性要件，并带上必看因素与记录', () => {
  const { system, user } = buildOpinionRequest(input());
  assert.match(system, /只输出 JSON/u);
  assert.match(system, /逐字/u);
  assert.match(system, /不得输出「成立\/不成立」/u);

  const payload = JSON.parse(user) as { items: { elementId: string; factors: string[] }[]; findings: { id: string }[] };
  assert.equal(payload.items.length, specs.length);
  for (const item of payload.items) assert.ok(item.factors.length > 0, '每个要件都要给出必看因素');
  assert.ok(payload.findings.length > 0, '必须把记录交给模型');
});

test('严格解析：合法的"倾向 + 把握度 + 引用"通过', () => {
  const opinions = parseOpinions(output(), input());
  assert.equal(opinions.length, specs.length);
  assert.equal(opinions[0]?.tendency, 'unclear');
  assert.equal(opinions[0]?.confidence, 'low');
  assert.equal(opinions[0]?.citations[0]?.findingId, firstFinding.id);
});

test('严格解析：编造引文会被拒绝，而不是被静默接受', () => {
  const bad = output();
  (bad.opinions[0]!.citations as { findingId: string; quote: string }[])[0]!.quote = '材料里根本没有这句话';
  assert.throws(
    () => parseOpinions(bad, input()),
    (error: unknown) => error instanceof OpinionError && error.code === 'OPINION_QUOTE_INVALID',
  );
});

test('严格解析：无引用、非法枚举、未知字段、缺要件都会被拒绝', () => {
  const cases: [string, () => unknown][] = [
    ['无引用', () => { const out = output(); out.opinions[0]!.citations = []; return out; }],
    ['非法倾向', () => { const out = output(); out.opinions[0]!.tendency = '成立'; return out; }],
    ['非法把握度', () => { const out = output(); out.opinions[0]!.confidence = 'very_high'; return out; }],
    ['未知字段', () => { const out = output(); out.opinions[0]!.conclusion = '成立'; return out; }],
    ['缺要件', () => ({ opinions: [output().opinions[0]!] })],
    ['不在请求内', () => { const out = output(); out.opinions[0]!.elementId = 'labor.termination.date'; return out; }],
    ['空理由', () => { const out = output(); out.opinions[0]!.reasoning = '   '; return out; }],
  ];
  for (const [name, make] of cases) {
    assert.throws(() => parseOpinions(make(), input()), OpinionError, `${name} 应被拒绝`);
  }
});

test('评估：只调用一次模型，并记录模型与输入指纹', async () => {
  let calls = 0;
  const model = {
    id: 'test-provider', model: 'fake-1',
    async complete(): Promise<unknown> { calls += 1; return output('likely'); },
  };
  const result = await evaluateOpinions({ ...input(), states: new Map(specs.map((spec) => [spec.elementId, 'statement_only' as const])) }, model);
  assert.equal(calls, 1, '一次评估只调用一次');
  assert.equal(result.model.model, 'fake-1');
  assert.match(result.inputDigest, /^[0-9a-f]{64}$/u);
  assert.equal(result.opinions[0]?.tendency, 'likely');
});

test('评估不改变任何要件状态与争点状态', async () => {
  const before = assessRun(knowledge, TERMINATION_RUN);
  const model = { id: 't', model: 'f', async complete(): Promise<unknown> { return output('unclear'); } };
  await evaluateOpinions(input(), model);
  const after = assessRun(knowledge, TERMINATION_RUN);
  assert.deepEqual(after.elements.map((element) => element.state), before.elements.map((element) => element.state));
  assert.deepEqual(after.issues.map((issue) => issue.state), before.issues.map((issue) => issue.state));
});

test('没有评价性要件时不发起调用', async () => {
  let calls = 0;
  const model = { id: 't', model: 'f', async complete(): Promise<unknown> { calls += 1; return output(); } };
  await assert.rejects(
    () => evaluateOpinions({ specs: [], run: TERMINATION_RUN, states }, model),
    (error: unknown) => error instanceof OpinionError && error.code === 'OPINION_NOTHING_TO_EVALUATE',
  );
  assert.equal(calls, 0);
});

test('知识包只把评价性要件挂到提问模板上', () => {
  assert.equal(specs.length, 2);
  for (const spec of specs) {
    const element = knowledge.elements.find((item) => item.id === spec.elementId);
    assert.equal(element?.kind, 'evaluative');
    assert.ok(spec.question.length > 0 && spec.factors.length > 0);
  }
});
