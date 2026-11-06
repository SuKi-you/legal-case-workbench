import assert from 'node:assert/strict';
import test from 'node:test';
import { assessChecks, assessRun } from '../src/kernel/assess.ts';
import type { CheckSpec, DomainKnowledge, ElementState, RunView } from '../src/kernel/contracts.ts';
import { validateKnowledge } from '../src/kernel/schema.ts';

// A generic delivery domain: these tests must not depend on labor-specific values or rules.
const domain: DomainKnowledge = {
  id: 'delivery.demo', version: '1', domain: '交付测试', stance: 'neutral', sources: {}, fallbackIssueId: 'delivery',
  issues: [{ id: 'delivery', title: '交付情况', caseTypes: ['交付'], elements: ['delivery.fact'],
    rules: [{ all: [], then: 'insufficient', reason: '保留待核对状态' }] }],
  elements: [{ id: 'delivery.fact', issueId: 'delivery', title: '交付凭证', needs: ['delivery.need'], critical: false,
    kind: 'factual', burden: 'shared', materials: ['document', 'statement'], minimumSupport: 'document' }],
};
const run: RunView = {
  id: 'delivery.run', goal: '核对交付', status: 'completed', sources: [{ materialId: 'm', versionId: 'v' }],
  findings: [{ id: 'delivery.finding', needId: 'delivery.need', statement: '相机已交付',
    citations: [{ materialId: 'm', versionId: 'v', start: 0, end: 5, quote: '相机已交付' }],
    record: { polarity: 'affirmed', value: { kind: 'text', raw: '已交付', normalized: '已交付' } } }],
};
const claim = { needId: 'delivery.need', values: ['已交付', '已签收'] };
const gap = { elementId: 'delivery.fact', kind: 'missing_document' as const };
const fixture = assessRun(domain, run);
const context = { elements: fixture.elements, gaps: fixture.gaps };
const states = new Map<string, ElementState>([['delivery.fact', 'statement_only']]);
const check = (conditions: Partial<CheckSpec> = {}): CheckSpec => ({
  id: 'delivery.check', title: '核对交付', severity: 'info', when: [], message: '核对材料', statute: [], ...conditions,
});
const knowledge = (spec: CheckSpec): DomainKnowledge => ({ ...domain, checks: [spec] });
const triggered = (spec: CheckSpec, ctx = context) => assessChecks(knowledge(spec), states, '签收记录', ctx).length > 0;

test('a standalone structured claim is valid and triggers through the complete generic assessment', () => {
  const spec = check({ claim });
  assert.deepEqual(validateKnowledge(knowledge(spec)), []);
  assert.equal(assessRun(knowledge(spec), run).checks.length, 1);
});

test('claim-only checks require a matching value in the declared need, and missing context never matches', () => {
  const spec = check({ claim });
  assert.equal(triggered(spec), true);
  assert.equal(triggered(check({ claim: { ...claim, values: ['未交付'] } })), false);
  assert.equal(triggered(spec, { ...context, elements: context.elements.map(element => ({ ...element, needIds: ['another.need'] })) }), false);
  assert.deepEqual(assessChecks(knowledge(spec), states, '签收记录'), []);
});

test('a standalone computed gap is valid, and requires the actual matching element and kind', () => {
  const spec = check({ gap });
  assert.deepEqual(validateKnowledge(knowledge(spec)), []);
  assert.equal(assessRun(knowledge(spec), run).checks.length, 1);
  assert.equal(triggered(check({ gap: { ...gap, kind: 'missing_period' } })), false);
  assert.equal(triggered(spec, { ...context, gaps: [] }), false);
  assert.equal(triggered(spec, { ...context, gaps: context.gaps.map(item => ({ ...item, elementId: 'another.element' })) }), false);
});

test('claim plus gap without when is AND for all four truth-table combinations', () => {
  const spec = check({ claim, gap });
  assert.deepEqual(validateKnowledge(knowledge(spec)), []);
  for (const claimMatches of [false, true]) for (const gapMatches of [false, true]) {
    const ctx = { elements: context.elements.map(element => ({ ...element, claimValues: claimMatches ? ['已签收'] : ['未交付'] })),
      gaps: gapMatches ? context.gaps : [] };
    assert.equal(triggered(spec, ctx), claimMatches && gapMatches, `${claimMatches}/${gapMatches}`);
  }
});

test('when plus claim plus gap stays AND across all eight truth-table combinations', () => {
  const spec = check({ when: [{ elementId: 'delivery.fact', in: ['statement_only'] }], claim, gap });
  assert.deepEqual(validateKnowledge(knowledge(spec)), []);
  for (const whenMatches of [false, true]) for (const claimMatches of [false, true]) for (const gapMatches of [false, true]) {
    const state = new Map<string, ElementState>([['delivery.fact', whenMatches ? 'statement_only' : 'unread']]);
    const ctx = { elements: context.elements.map(element => ({ ...element, claimValues: claimMatches ? ['已交付'] : ['未交付'] })),
      gaps: gapMatches ? context.gaps : [] };
    const result = assessChecks(knowledge(spec), state, '签收记录', ctx);
    assert.equal(result.length > 0, whenMatches && claimMatches && gapMatches, `${whenMatches}/${claimMatches}/${gapMatches}`);
  }
});

test('all entries inside when also remain conjunctive, including a state and signal in one entry', () => {
  const spec = check({ when: [{ elementId: 'delivery.fact', in: ['statement_only'], signal: '签收' }, { signal: '记录' }] });
  assert.deepEqual(validateKnowledge(knowledge(spec)), []);
  assert.equal(triggered(spec), true);
  assert.deepEqual(assessChecks(knowledge(spec), states, '签收', context), []);
  assert.deepEqual(assessChecks(knowledge(spec), new Map([['delivery.fact', 'unread']]), '签收记录', context), []);
});

test('a rule with no effective condition is rejected by validation and does not execute', () => {
  const spec = check();
  assert.ok(validateKnowledge(knowledge(spec)).some(problem => problem.includes('没有触发条件')));
  assert.equal(triggered(spec), false);
});

test('invalid structured conditions cannot turn empty when into an unconditional check or be ignored beside a valid clause', () => {
  const invalidConditions: Partial<CheckSpec>[] = [
    { claim: { needId: 'absent.need', values: ['已交付'] } },
    { claim: { ...claim, values: [] } },
    { claim: { ...claim, values: [' '] } },
    { gap: { ...gap, elementId: 'absent.element' } },
    { gap: { ...gap, kind: 'bad_kind' as typeof gap.kind } },
  ];
  for (const invalid of invalidConditions) {
    for (const otherCondition of [{}, { claim, gap }, { when: [{ elementId: 'delivery.fact', in: ['statement_only'] as ElementState[] }] }]) {
      const spec = check({ ...otherCondition, ...invalid });
      assert.ok(validateKnowledge(knowledge(spec)).length > 0, JSON.stringify(spec));
      assert.equal(triggered(spec), false, JSON.stringify(spec));
    }
  }
});

test('invalid when entries reject the complete rule even with otherwise valid claim and gap', () => {
  const invalidWhen: CheckSpec['when'][] = [
    [{}], [{ signal: '' }], [{ signal: '  ' }],
    [{ elementId: 'absent.element', in: ['statement_only'] }],
    [{ elementId: 'delivery.fact', in: [] }], [{ elementId: 'delivery.fact' }],
    [{ elementId: 'delivery.fact', in: ['unknown' as ElementState] }],
    [{ signal: '签收', in: ['statement_only'] }],
  ];
  for (const when of invalidWhen) {
    const spec = check({ when, claim, gap });
    assert.ok(validateKnowledge(knowledge(spec)).length > 0, JSON.stringify(when));
    assert.equal(triggered(spec), false, JSON.stringify(when));
  }
});
