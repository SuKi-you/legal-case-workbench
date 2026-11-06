import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { compareInformation, InformationComparisonError } from '../src/information/compare.ts';
import {
  informationAnalysisSchema, type InformationEntity, type InformationFinding, type InformationRecord,
} from '../src/information/contracts.ts';

const entity = (name = '陈某', value: string | null = 'E001'): InformationEntity => ({
  name, kind: 'person', identity: value === null ? null : { scheme: 'employee-id', value },
});
function record(overrides: Partial<InformationRecord> = {}): InformationRecord {
  return {
    topic: 'transfer.amount', subject: entity(), object: null, attributedTo: null,
    event: { type: 'transfer', key: 'T001', description: '流水号T001转账' },
    time: { raw: '2026年9月10日', start: '2026-09-10', end: '2026-09-10', precision: 'date' },
    value: { kind: 'money', raw: '8000元', normalized: '8000', unit: 'CNY' },
    polarity: 'affirmed', period: '2026-09', basis: '实发', origin: 'party_statement',
    qualifiers: {}, uncertainty: [], ...overrides,
  };
}
function finding(value = record(), statement = '陈某称流水号T001付款8000元。'): InformationFinding {
  return { id: randomUUID(), needId: 'test.transfer', statement, record: structuredClone(value),
    citations: [{ materialId: randomUUID(), versionId: randomUUID(), start: 0, end: statement.length,
      quote: statement, textSha256: createHash('sha256').update(statement).digest('hex') }] };
}
const amount = (normalized: string | null) => ({ kind: 'money' as const, raw: normalized ? `${normalized}元` : null, normalized, unit: 'CNY' });
const unknownTime: InformationRecord['time'] = { raw: null, start: null, end: null, precision: 'unknown' };
const boolean = (normalized: string | null): InformationRecord['value'] => ({ kind: 'boolean', raw: normalized, normalized, unit: null });
const inconsistent = (result: ReturnType<typeof compareInformation>) => result.conflicts.filter((item) => item.classification === 'inconsistent');

test('structured claims with different wording associate one event and retain every source', () => {
  const a = finding(record(), '工号E001陈某说T001这笔钱实发8000元。');
  const b = finding(record({ origin: 'document_record' }), '流水T001列明E001实收八千元人民币。');
  const input = [a, b];
  const before = structuredClone(input);
  const result = compareInformation(input);
  assert.ok(result.relations.some((item) => item.kind === 'same_entity' && item.status === 'confirmed'));
  assert.ok(result.relations.some((item) => item.kind === 'same_event' && item.status === 'confirmed'));
  const equivalent = result.relations.find((item) => item.kind === 'equivalent_claim');
  assert.deepEqual(equivalent?.findingIds, [a.id, b.id].sort());
  assert.equal(result.entities.find((item) => item.findingIds.length === 2)?.names[0], '陈某');
  assert.equal(inconsistent(result).length, 0);
  assert.deepEqual(input, before, 'Grouping may not rewrite source findings or citations.');
  informationAnalysisSchema.parse({ version: 1, ...result, needs: [] });
});

test('same names with different explicit identities never merge people or create an amount conflict', () => {
  const a = finding(), b = finding(record({ subject: entity('陈某', 'E002'), value: amount('6000') }));
  const result = compareInformation([a, b]);
  assert.equal(result.entities.length, 2);
  assert.equal(result.relations.some((item) => item.kind === 'same_entity' || item.kind === 'same_event' || item.kind === 'equivalent_claim'), false);
  assert.equal(inconsistent(result).length, 0);
  assert.ok(result.conflicts.some((item) => item.classification === 'different_scope' && item.field === 'subject'));
});

test('a shared name without identity is only a suggestion, not a confirmed person or contradiction', () => {
  const a = finding(record({ subject: entity('张经理', null) }));
  const b = finding(record({ subject: entity('张经理', null), value: amount('6000') }));
  const result = compareInformation([a, b]);
  assert.equal(result.entities.length, 2);
  assert.ok(result.relations.some((item) => item.kind === 'possible_same_entity' && item.status === 'suggested'));
  assert.equal(result.relations.some((item) => item.kind === 'same_entity'), false);
  assert.equal(inconsistent(result).length, 0);
  assert.ok(result.conflicts.some((item) => item.classification === 'possible_conflict'));
});

test('explicit human alias bindings link differently named mentions with a recorded rationale', () => {
  const a = finding(record({ subject: entity('张某', null) }));
  const b = finding(record({ subject: entity('张经理', null) }), '张经理陈述同一笔转账。');
  const result = compareInformation([a, b], { bindings: [{ names: ['张某', '张经理'], canonical: '本案张某', reason: '律师根据原始身份记录确认' }] });
  assert.equal(result.entities.length, 1);
  assert.deepEqual(result.entities[0]!.names, ['张某', '张经理'].sort());
  assert.ok(result.relations.some((item) => item.kind === 'equivalent_claim'));
});

test('contradictory explicit identities cannot be bridged by aliases or unlabelled mentions', () => {
  const a = finding(record({ subject: entity('张某', 'A001') }));
  const b = finding(record({ subject: entity('张经理', null) }));
  const c = finding(record({ subject: entity('另一张某', 'A002') }));
  assert.throws(() => compareInformation([a, b, c], { bindings: [{
    names: ['张某', '张经理', '另一张某'], canonical: '张某', reason: '错误的同人绑定',
  }] }), InformationComparisonError);
  assert.throws(() => compareInformation([a], { bindings: [
    { names: ['张某', '张经理'], canonical: '甲', reason: '绑定一' },
    { names: ['张经理', '张老师'], canonical: '乙', reason: '绑定二' },
  ] }), /incompatible explicit entity bindings/);
});

test('shared text content is linked without deleting sources or claiming independent corroboration', () => {
  const a = finding(), b = finding();
  const result = compareInformation([a, b]);
  const sameContent = result.relations.find((item) => item.kind === 'same_source_content');
  assert.deepEqual(sameContent?.findingIds, [a.id, b.id].sort());
  assert.match(sameContent!.reason, /不能.*独立佐证/);
  assert.notEqual(a.citations[0]!.materialId, b.citations[0]!.materialId);
});

test('different text revisions of one material are version differences, not independent factual contradictions', () => {
  const a = finding(), b = finding(record({ value: amount('6000') }), '本材料的人工修订记载6000元。');
  b.citations[0]!.materialId = a.citations[0]!.materialId;
  const result = compareInformation([a, b]);
  assert.equal(inconsistent(result).length, 0);
  assert.ok(result.conflicts.some((item) => item.field === 'source_version' && item.classification === 'different_scope'));
});

test('an attribute claim can be equivalent while event identity remains a candidate', () => {
  const a = finding(record({ topic: 'salary.agreed', event: { type: 'salary', key: null, description: '九月工资' }, time: unknownTime }));
  const b = finding(record({ topic: 'salary.agreed', event: { type: 'salary', key: null, description: '9月报酬' }, time: unknownTime }), '相同工号记载同月同口径报酬。');
  const result = compareInformation([a, b]);
  assert.ok(result.relations.some((item) => item.kind === 'possible_same_event'));
  assert.equal(result.relations.some((item) => item.kind === 'same_event'), false);
  assert.ok(result.relations.some((item) => item.kind === 'equivalent_claim'));
});

test('known comparable numeric differences identify inconsistent records with both source IDs', () => {
  const a = finding(), b = finding(record({ value: amount('6000') }));
  const conflict = inconsistent(compareInformation([a, b]));
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0]!.field, 'value');
  assert.deepEqual(conflict[0]!.findingIds, [a.id, b.id].sort());
  assert.match(conflict[0]!.reason, /不一致/);
  assert.match(conflict[0]!.reason, /尚不判断.*真实/);
});

test('canonical decimal comparison handles equivalent formatting and values beyond floating point precision', () => {
  const a = finding(record({ value: amount('0008000.000') }));
  const b = finding(record({ value: amount('+8000') }));
  assert.equal(inconsistent(compareInformation([a, b])).length, 0);
  assert.ok(compareInformation([a, b]).relations.some((item) => item.kind === 'equivalent_claim'));
  const largeA = finding(record({ value: amount('9007199254740992') }));
  const largeB = finding(record({ value: amount('9007199254740993') }));
  assert.equal(inconsistent(compareInformation([largeA, largeB])).length, 1);
});

test('different periods, payment bases, units and as-of qualifiers do not become definite conflicts', async (t) => {
  const variants: Array<{ field: string; base?: Partial<InformationRecord>; change: Partial<InformationRecord> }> = [
    { field: 'period', change: { period: '2026-10' } },
    { field: 'basis', change: { basis: '税前' } },
    { field: 'unit', change: { value: { ...amount('6000'), unit: 'USD' } } },
    { field: 'qualifiers', base: { qualifiers: { asOf: '2026-09-10' } }, change: { qualifiers: { asOf: '2026-09-20' } } },
  ];
  for (const variant of variants) await t.test(variant.field, () => {
    const result = compareInformation([finding(record(variant.base)), finding(record({ value: amount('6000'), ...variant.change }))]);
    assert.equal(inconsistent(result).length, 0);
    assert.ok(result.conflicts.some((item) => item.field === variant.field && item.classification === 'different_scope'));
    assert.equal(result.relations.some((item) => item.kind === 'equivalent_claim'), false);
  });
});

test('an omitted qualifier leaves a monetary discrepancy for review instead of declaring different scopes', () => {
  const a = finding(record({ qualifiers: { asOf: '2026-09-10' } }));
  const b = finding(record({ value: amount('6000') }));
  const result = compareInformation([a, b]);
  assert.equal(inconsistent(result).length, 0);
  assert.equal(result.conflicts.some((item) => item.classification === 'different_scope'), false);
  assert.ok(result.conflicts.some((item) => item.classification === 'possible_conflict' && /限定条件对应/u.test(item.reason)));
  assert.equal(result.relations.some((item) => item.kind === 'equivalent_claim'), false);
  assert.deepEqual(result, compareInformation([b, a]));
});

test('equal values with an omitted qualifier cannot establish equivalent claims', () => {
  const a = finding(record({ qualifiers: { asOf: '2026-09-10' } }));
  const b = finding();
  const result = compareInformation([a, b]);
  assert.equal(result.relations.some((item) => item.kind === 'equivalent_claim'), false);
  assert.equal(result.conflicts.length, 0, 'Unknown qualifiers alone are not affirmative contradictory claims.');
});

test('same explicit event with different recorded dates identifies a date discrepancy', () => {
  const a = finding(), b = finding(record({ time: { raw: '2026年9月15日', start: '2026-09-15', end: '2026-09-15', precision: 'date' } }));
  const result = compareInformation([a, b]);
  assert.ok(result.relations.some((item) => item.kind === 'same_event'));
  assert.ok(inconsistent(result).some((item) => item.field === 'time'));
  assert.equal(result.relations.some((item) => item.kind === 'equivalent_claim'), false);
});

test('overlapping month and day descriptions of the same event are not conflicting dates', () => {
  const a = finding(record({ time: { raw: '2026年9月', start: '2026-09-01', end: '2026-09-30', precision: 'month' } }));
  const b = finding();
  const result = compareInformation([a, b]);
  assert.ok(result.relations.some((item) => item.kind === 'same_event'));
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.relations.some((item) => item.kind === 'equivalent_claim'), false,
    'The finer date should remain separately recorded rather than discard the precision difference.');
  const differentAmount = finding(record({ value: amount('6000') }));
  const discrepancy = compareInformation([a, differentAmount]);
  assert.ok(inconsistent(discrepancy).some((item) => item.field === 'value'));
  assert.equal(discrepancy.conflicts.some((item) => item.field === 'time'), false);
});

test('different dates without a shared event identity remain separate event scopes', () => {
  const a = finding(record({ event: { type: 'transfer', key: null, description: '转账' } }));
  const b = finding(record({ event: { type: 'transfer', key: null, description: '转账' }, value: amount('6000'),
    time: { raw: '2026年9月15日', start: '2026-09-15', end: '2026-09-15', precision: 'date' } }));
  const result = compareInformation([a, b]);
  assert.equal(inconsistent(result).length, 0);
  assert.ok(result.conflicts.some((item) => item.field === 'time' && item.classification === 'different_scope'));
});

test('unknown periods and relative times cannot establish a definite contradiction', () => {
  const base = record({ event: { type: 'transfer', key: null, description: '一笔转账' }, period: null,
    time: { raw: '上周', start: null, end: null, precision: 'relative' } });
  const a = finding(base), b = finding({ ...base, value: amount('6000') });
  const result = compareInformation([a, b]);
  assert.equal(inconsistent(result).length, 0);
  assert.ok(result.conflicts.some((item) => item.classification === 'insufficient_context'));
});

test('a missing amount basis or unit preserves a possible discrepancy instead of asserting conflict', () => {
  for (const change of [{ basis: null }, { value: { ...amount('6000'), unit: null } }]) {
    const result = compareInformation([finding(), finding(record({ value: amount('6000'), ...change }))]);
    assert.equal(inconsistent(result).length, 0);
    assert.ok(result.conflicts.some((item) => item.classification === 'possible_conflict'));
  }
});

test('approximate amounts and inferences stay possible conflicts even in comparable contexts', () => {
  for (const change of [{ uncertainty: ['金额约数，尚待核对'] }, { origin: 'inference' as const }]) {
    const result = compareInformation([finding(), finding(record({ value: amount('6000'), ...change }))]);
    assert.equal(inconsistent(result).length, 0);
    assert.ok(result.conflicts.some((item) => item.classification === 'possible_conflict'));
  }
});

test('different free-text values need review and are not treated as mutually exclusive by string inequality alone', () => {
  const base = record({ topic: 'notice.words', value: { kind: 'text', raw: '别来了', normalized: '别来了', unit: null } });
  const other = { ...base, value: { kind: 'text' as const, raw: '暂时休息', normalized: '暂时休息', unit: null } };
  const result = compareInformation([finding(base), finding(other)]);
  assert.equal(inconsistent(result).length, 0);
  assert.ok(result.conflicts.some((item) => item.classification === 'possible_conflict'));
});

test('boolean normalized truth is not inverted twice when polarity is denied', () => {
  const base = record({ topic: 'payment.received', value: boolean('false'), polarity: 'denied' });
  const same = compareInformation([finding(base), finding({ ...base, polarity: 'denied' }, '当事人称该笔款项尚未收到。')]);
  assert.equal(inconsistent(same).length, 0);
  assert.ok(same.relations.some((item) => item.kind === 'equivalent_claim'));
  const opposite = compareInformation([finding(base), finding(record({ topic: 'payment.received', value: boolean('true'), polarity: 'affirmed' }))]);
  assert.ok(inconsistent(opposite).some((item) => item.field === 'polarity'));
});

test('a clear boolean polarity can be compared when the normalized boolean is absent', () => {
  const base = record({ topic: 'payment.received', value: boolean(null), polarity: 'affirmed' });
  const result = compareInformation([finding(base), finding({ ...base, polarity: 'denied' })]);
  assert.equal(inconsistent(result).length, 1);
});

test('denials of different attribute values do not create false logical contradictions', () => {
  const is6000 = record({ value: amount('6000'), polarity: 'affirmed' });
  const not8000 = record({ value: amount('8000'), polarity: 'denied' });
  assert.equal(inconsistent(compareInformation([finding(is6000), finding(not8000)])).length, 0);
  const not6000 = { ...is6000, polarity: 'denied' as const };
  assert.equal(inconsistent(compareInformation([finding(not6000), finding(not8000)])).length, 0);
  assert.equal(inconsistent(compareInformation([finding(is6000), finding(not6000)])).length, 1,
    'The same numeric proposition both affirmed and denied is an inconsistency.');
});

test('uncertain polarity and invalid normalized booleans cannot become definite contradictions', () => {
  const uncertain = record({ value: amount('6000'), polarity: 'uncertain' });
  const result = compareInformation([finding(), finding(uncertain)]);
  assert.equal(inconsistent(result).length, 0);
  assert.ok(result.conflicts.some((item) => item.classification === 'possible_conflict'));
  const malformed = record({ topic: 'payment.received', value: boolean('yes'), polarity: 'affirmed' });
  const denied = record({ topic: 'payment.received', value: boolean('false'), polarity: 'denied' });
  assert.equal(inconsistent(compareInformation([finding(malformed), finding(denied)])).length, 0);
});

test('unknown and malformed numeric values cannot produce equivalent or definitely conflicting amounts', () => {
  const unknown = record({ value: { kind: 'unknown', raw: null, normalized: null, unit: null } });
  const result = compareInformation([finding(unknown), finding(unknown)]);
  assert.equal(result.relations.some((item) => item.kind === 'equivalent_claim'), false);
  assert.equal(inconsistent(result).length, 0);
  const malformed = record({ value: amount('六千') });
  assert.equal(inconsistent(compareInformation([finding(malformed), finding()])).length, 0);
});

test('unknown actor identities or changed topics cannot be equated solely by words, amounts or event IDs', () => {
  const unidentified = record({ subject: entity('陈某', null) });
  assert.equal(compareInformation([finding(unidentified), finding(unidentified)]).relations.some((item) => item.kind === 'equivalent_claim'), false);
  const otherTopic = record({ topic: 'salary.agreed' });
  assert.equal(compareInformation([finding(), finding(otherTopic)]).relations.some((item) => item.kind === 'equivalent_claim'), false);
});

test('old unstructured findings remain readable and comparisons are deterministic and order independent', () => {
  const a = finding(), b = finding(record({ value: amount('6000') }));
  const legacy = finding(); delete legacy.record;
  const before = structuredClone([a, b, legacy]);
  assert.deepEqual(compareInformation([a, b, legacy]), compareInformation([legacy, b, a]));
  assert.deepEqual([a, b, legacy], before);
  for (const item of [...compareInformation([a, b, legacy]).relations, ...compareInformation([a, b, legacy]).conflicts]) {
    assert.ok(item.findingIds.every((findingId) => [a.id, b.id, legacy.id].includes(findingId)));
  }
  assert.throws(() => compareInformation([a, a]), /Finding IDs must be unique/);
});
