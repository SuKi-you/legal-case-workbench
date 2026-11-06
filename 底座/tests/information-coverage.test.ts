import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { evaluateInformationNeeds } from '../src/information/coverage.ts';
import {
  type InformationAttempt, type InformationConflict, type InformationFinding, type InformationRecord,
  type InformationSource, type StructuredNeed,
} from '../src/information/contracts.ts';

const source = (): InformationSource => ({ materialId: randomUUID(), versionId: randomUUID(), textSha256: 'a'.repeat(64) });
function record(patch: Partial<InformationRecord> = {}): InformationRecord {
  return {
    topic: 'attendance.notice', subject: { name: '陈某', kind: 'person', identity: { scheme: 'employee', value: 'S001' } },
    object: null, attributedTo: { name: '陈某', kind: 'person', identity: { scheme: 'employee', value: 'S001' } },
    event: { type: 'oral-notice', key: 'N001', description: '记载停止到岗的口头表达' },
    time: { raw: '2026年9月1日', start: '2026-09-01', end: '2026-09-01', precision: 'date' },
    value: { kind: 'text', raw: '主管口头说让我别来了', normalized: '主管口头说让我别来了', unit: null },
    polarity: 'affirmed', period: null, basis: null, origin: 'party_statement', qualifiers: {}, uncertainty: [],
    ...patch,
  };
}
function need(patch: Partial<NonNullable<StructuredNeed['spec']>> = {}): StructuredNeed {
  return { id: 'need.notice', question: '材料如何记载停止到岗的通知？', reason: '保留已经提供的陈述及其出处。',
    spec: { topic: 'attendance.notice', subject: 'S001', object: null, period: null, basis: null,
      requiredFields: ['subject', 'value'], minimumSupport: 'statement', applicable: true, ...patch } };
}
function finding(selected: InformationSource, patch: Partial<InformationRecord> = {}, needId = 'need.notice'): InformationFinding {
  return { id: randomUUID(), needId, statement: '当事人陈述：主管口头说让我别来了。', record: record(patch),
    citations: [{ ...selected, start: 0, end: 4, quote: '虚构原文' }] };
}
function attempt(needId: string, examined: InformationSource[], findings: InformationFinding[] = []): InformationAttempt {
  return { request: { needId, instruction: '核对对应材料原话', reason: '先查已有材料' }, examined,
    findingIds: findings.map((item) => item.id), note: '已读取选定来源，不自动认定法律事实。' };
}
function evaluate(options: {
  needs?: StructuredNeed[]; findings?: InformationFinding[]; sources: InformationSource[];
  attempts?: InformationAttempt[]; conflicts?: InformationConflict[];
}) {
  return evaluateInformationNeeds({ needs: options.needs ?? [need()], findings: options.findings ?? [],
    sources: options.sources, attempts: options.attempts ?? [], conflicts: options.conflicts ?? [] });
}

test('a provided source-backed notice remains a provided statement and is not asked for again', () => {
  const first = source(), unread = source();
  const found = finding(first);
  const [result] = evaluate({ sources: [first, unread], findings: [found], attempts: [attempt('need.notice', [first], [found])] });
  assert.equal(result?.coverage, 'found');
  assert.equal(result?.support, 'statement_only');
  assert.equal(result?.satisfaction, 'satisfied');
  assert.deepEqual(result?.unread, [unread]);
  assert.deepEqual(result?.nextActions, []);
});

test('not yet read and searched without a match remain distinct coverage states', () => {
  const first = source(), second = source();
  const [partialSearch] = evaluate({ sources: [first, second], attempts: [attempt('need.notice', [first])] });
  assert.equal(partialSearch?.coverage, 'unread');
  assert.equal(partialSearch?.nextActions[0]?.kind, 'read');
  assert.deepEqual(partialSearch?.examined, [first]);
  assert.deepEqual(partialSearch?.unread, [second]);
  const [searched] = evaluate({ sources: [first, second], attempts: [attempt('need.notice', [first, second])] });
  assert.equal(searched?.coverage, 'not_found_in_examined');
  assert.equal(searched?.nextActions[0]?.kind, 'clarify');
  assert.match(searched!.reason, /本次.*范围内未找到/);
});

test('a known record can answer another need without falsifying its per-need search ledger', () => {
  const selected = source();
  const found = finding(selected, {}, 'need.other');
  const [result] = evaluate({ sources: [selected], findings: [found], attempts: [attempt('need.other', [selected], [found])] });
  assert.equal(result?.satisfaction, 'satisfied');
  assert.deepEqual(result?.findingIds, [found.id]);
  assert.deepEqual(result?.examined, []);
  assert.deepEqual(result?.unread, [selected]);
});

test('relative dates stay partial when an explicit time is required and only that gap is requested', () => {
  const selected = source();
  const found = finding(selected, { time: { raw: '上周', start: null, end: null, precision: 'relative' } });
  const [result] = evaluate({ needs: [need({ requiredFields: ['subject', 'value', 'time'] })], sources: [selected],
    findings: [found], attempts: [attempt('need.notice', [selected], [found])] });
  assert.equal(result?.coverage, 'partial');
  assert.equal(result?.satisfaction, 'needs_information');
  assert.deepEqual(result?.missingFields, ['time']);
  assert.equal(result?.nextActions[0]?.kind, 'clarify');
  assert.match(result!.nextActions[0]!.instruction, /明确时间/);
  assert.doesNotMatch(result!.nextActions[0]!.instruction, /是否.*通知/);
});

test('invalid calendar dates cannot satisfy a required time while a known month can', () => {
  const selected = source();
  const invalid = finding(selected, { time: { raw: '2026年2月30日', start: '2026-02-30', end: '2026-02-30', precision: 'date' } });
  const [bad] = evaluate({ needs: [need({ requiredFields: ['time'] })], sources: [selected], findings: [invalid],
    attempts: [attempt('need.notice', [selected], [invalid])] });
  assert.equal(bad?.satisfaction, 'needs_information');
  const month = finding(selected, { time: { raw: '2026年9月', start: '2026-09', end: null, precision: 'month' } });
  const [good] = evaluate({ needs: [need({ requiredFields: ['time'] })], sources: [selected], findings: [month],
    attempts: [attempt('need.notice', [selected], [month])] });
  assert.equal(good?.satisfaction, 'satisfied');
});

test('complementary fields join only for the same explicit event, confirmed identity and matching scope', () => {
  const first = source(), second = source();
  const a = finding(first, { value: { kind: 'unknown', raw: null, normalized: null, unit: null } });
  const b = finding(second, { time: { raw: null, start: null, end: null, precision: 'unknown' } });
  const options = { needs: [need({ requiredFields: ['time', 'value'] })], sources: [first, second], findings: [a, b],
    attempts: [attempt('need.notice', [first, second], [a, b])] };
  assert.equal(evaluate(options)[0]?.satisfaction, 'satisfied');
  const differentEvent = { ...b, record: { ...b.record!, event: { ...b.record!.event, key: 'N002' } } };
  assert.equal(evaluate({ ...options, findings: [a, differentEvent] })[0]?.satisfaction, 'needs_information');
  const unconfirmed = { ...b, record: { ...b.record!, subject: { ...b.record!.subject!, identity: null } } };
  assert.equal(evaluate({ ...options, findings: [a, unconfirmed] })[0]?.satisfaction, 'needs_information');
  const differentSnapshot = { ...b, record: { ...b.record!, qualifiers: { asOf: '2026-10-01' } } };
  assert.equal(evaluate({ ...options, findings: [a, differentSnapshot] })[0]?.satisfaction, 'needs_information');
});

test('one name with different explicit identities requires review while an identity selector disambiguates', () => {
  const first = source(), second = source();
  const a = finding(first), b = finding(second, { subject: { name: '陈某', kind: 'person', identity: { scheme: 'employee', value: 'S002' } } });
  const options = { sources: [first, second], findings: [a, b], attempts: [attempt('need.notice', [first, second], [a, b])] };
  const [ambiguous] = evaluate({ ...options, needs: [need({ subject: '陈某' })] });
  assert.equal(ambiguous?.consistency, 'ambiguous');
  assert.equal(ambiguous?.satisfaction, 'needs_review');
  assert.equal(ambiguous?.nextActions[0]?.kind, 'review');
  const [identified] = evaluate({ ...options, needs: [need({ subject: 'employee:S001' })] });
  assert.equal(identified?.satisfaction, 'satisfied');
  assert.deepEqual(identified?.findingIds, [a.id]);
});

test('scope mismatch is excluded and an unknown required scope remains a specific gap', () => {
  const selected = source();
  const unknown = finding(selected, { basis: null });
  const [missing] = evaluate({ needs: [need({ basis: '税前' })], sources: [selected], findings: [unknown],
    attempts: [attempt('need.notice', [selected], [unknown])] });
  assert.equal(missing?.coverage, 'partial');
  assert.deepEqual(missing?.missingFields, ['basis']);
  const other = finding(selected, { basis: '实发' });
  const [different] = evaluate({ needs: [need({ basis: '税前' })], sources: [selected], findings: [other],
    attempts: [attempt('need.notice', [selected], [other])] });
  assert.equal(different?.coverage, 'not_found_in_examined');
  assert.deepEqual(different?.findingIds, []);
});

test('inconsistency affects the need but a difference of scope does not create a false conflict', () => {
  const first = source(), second = source();
  const a = finding(first), b = finding(second, { polarity: 'denied' });
  const options = { sources: [first, second], findings: [a, b], attempts: [attempt('need.notice', [first, second], [a, b])] };
  const conflict: InformationConflict = { id: 'conflict-1', findingIds: [a.id, b.id], field: 'polarity', classification: 'inconsistent', reason: '同一事项有相反记载' };
  const [inconsistent] = evaluate({ ...options, conflicts: [conflict] });
  assert.equal(inconsistent?.consistency, 'conflicting');
  assert.equal(inconsistent?.satisfaction, 'needs_review');
  assert.deepEqual(inconsistent?.conflictIds, ['conflict-1']);
  const [differentScope] = evaluate({ ...options, conflicts: [{ ...conflict, classification: 'different_scope' }] });
  assert.equal(differentScope?.consistency, 'consistent');
  assert.deepEqual(differentScope?.conflictIds, []);
});

test('an unresolved comparison is kept for review and unrelated conflict pairs do not contaminate a need', () => {
  const selected = source();
  const a = finding(selected), b = finding(selected);
  const options = { sources: [selected], findings: [a, b], attempts: [attempt('need.notice', [selected], [a, b])] };
  const conflict: InformationConflict = { id: 'uncertain-1', findingIds: [a.id, b.id], field: 'period', classification: 'insufficient_context', reason: '期间尚未明确' };
  assert.equal(evaluate({ ...options, conflicts: [conflict] })[0]?.satisfaction, 'needs_review');
  const unrelated = finding(selected, { topic: 'another.topic' });
  const [result] = evaluate({ ...options, findings: [a, unrelated], conflicts: [{ ...conflict, findingIds: [a.id, unrelated.id] }] });
  assert.equal(result?.satisfaction, 'satisfied');
  assert.deepEqual(result?.conflictIds, []);
});

test('a statement cannot satisfy a document requirement and the follow-up asks only for support', () => {
  const selected = source();
  const found = finding(selected);
  const [result] = evaluate({ needs: [need({ minimumSupport: 'document' })], sources: [selected], findings: [found],
    attempts: [attempt('need.notice', [selected], [found])] });
  assert.equal(result?.coverage, 'found');
  assert.equal(result?.support, 'statement_only');
  assert.equal(result?.satisfaction, 'needs_information');
  assert.ok(result?.missingFields.includes('document_support'));
  assert.match(result!.nextActions[0]!.instruction, /已有.*相关陈述.*支持材料/);
  assert.doesNotMatch(result!.nextActions[0]!.instruction, /是否.*通知/);
});

test('document support must cover required fields of the identified event rather than merely mention its ID', () => {
  const first = source(), second = source();
  const statement = finding(first);
  const document = finding(second, { origin: 'document_record', value: { kind: 'unknown', raw: null, normalized: null, unit: null } });
  const options = { needs: [need({ minimumSupport: 'document', requiredFields: ['value'] })], sources: [first, second],
    findings: [statement, document], attempts: [attempt('need.notice', [first, second], [statement, document])] };
  const [incomplete] = evaluate(options);
  assert.equal(incomplete?.support, 'document_supported');
  assert.equal(incomplete?.satisfaction, 'needs_information');
  assert.ok(incomplete?.missingFields.includes('document_support'));
  const supported = { ...document, record: { ...document.record!, value: statement.record!.value } };
  assert.equal(evaluate({ ...options, findings: [statement, supported] })[0]?.satisfaction, 'satisfied');
});

test('inference-only records cannot satisfy a need for observed information', () => {
  const selected = source();
  const inferred = finding(selected, { origin: 'inference' });
  const [result] = evaluate({ sources: [selected], findings: [inferred], attempts: [attempt('need.notice', [selected], [inferred])] });
  assert.equal(result?.support, 'inference_only');
  assert.equal(result?.satisfaction, 'needs_review');
  assert.equal(result?.nextActions[0]?.kind, 'review');
});

test('an explicit false value is information while uncertain polarity requires review', () => {
  const selected = source();
  const negative = finding(selected, { value: { kind: 'boolean', raw: '没有', normalized: 'false', unit: null } });
  const options = { sources: [selected], findings: [negative], attempts: [attempt('need.notice', [selected], [negative])] };
  assert.equal(evaluate(options)[0]?.satisfaction, 'satisfied');
  const uncertain = { ...negative, record: { ...negative.record!, polarity: 'uncertain' as const } };
  assert.equal(evaluate({ ...options, findings: [uncertain] })[0]?.satisfaction, 'needs_review');
});

test('denying a money, number or date value preserves the exclusion while requesting the exact value', () => {
  const selected = source();
  for (const value of [
    { kind: 'money' as const, raw: '不是6000元', normalized: '6000', unit: 'CNY' },
    { kind: 'number' as const, raw: '不是6次', normalized: '6', unit: '次' },
    { kind: 'date' as const, raw: '不是2026年9月1日', normalized: '2026-09-01', unit: null },
  ]) {
    const denied = finding(selected, { value, polarity: 'denied' });
    const [result] = evaluate({ needs: [need({ requiredFields: ['value'] })], sources: [selected], findings: [denied],
      attempts: [attempt('need.notice', [selected], [denied])] });
    assert.equal(result?.coverage, 'partial');
    assert.equal(result?.satisfaction, 'needs_information');
    assert.deepEqual(result?.findingIds, [denied.id]);
    assert.deepEqual(result?.missingFields, ['value']);
    assert.match(result!.reason, /排除性.*确切值/);
    assert.doesNotMatch(result!.nextActions[0]!.instruction, /是否.*否认/);
  }
});

test('an unanchored month and an explicit unresolved-year marker cannot become a known period or time', () => {
  const selected = source();
  const monthOnly = finding(selected, { period: '9月', time: { raw: '9月', start: null, end: null, precision: 'relative' } });
  const options = { needs: [need({ requiredFields: ['subject', 'value', 'period', 'time'] })], sources: [selected],
    findings: [monthOnly], attempts: [attempt('need.notice', [selected], [monthOnly])] };
  const [missingYear] = evaluate(options);
  assert.equal(missingYear?.satisfaction, 'needs_information');
  assert.deepEqual(new Set(missingYear?.missingFields), new Set(['period', 'time']));
  const guessedYear = { ...monthOnly, record: { ...monthOnly.record!, period: '2026-09',
    time: { raw: '9月', start: '2026-09', end: null, precision: 'month' as const }, uncertainty: ['年份未明确'] } };
  const [uncertainYear] = evaluate({ ...options, findings: [guessedYear] });
  assert.equal(uncertainYear?.satisfaction, 'needs_information');
  assert.deepEqual(new Set(uncertainYear?.missingFields), new Set(['period', 'time']));
});

test('not-applicable, unspecified requirements and legacy text records retain distinct meanings', () => {
  const selected = source();
  assert.equal(evaluate({ needs: [need({ applicable: false })], sources: [selected] })[0]?.satisfaction, 'not_applicable');
  assert.deepEqual(evaluate({ needs: [need({ applicable: false })], sources: [selected] })[0]?.nextActions, []);
  const unspecified = { id: 'need.notice', question: '核对已有材料', reason: '尚未声明专业匹配条件' };
  const [noSpec] = evaluate({ needs: [unspecified], sources: [selected] });
  assert.equal(noSpec?.satisfaction, 'needs_review');
  assert.ok(noSpec?.missingFields.includes('spec'));
  const legacy = finding(selected);
  delete legacy.record;
  const [noRecord] = evaluate({ sources: [selected], findings: [legacy], attempts: [attempt('need.notice', [selected], [legacy])] });
  assert.equal(noRecord?.satisfaction, 'needs_review');
  assert.ok(noRecord?.missingFields.includes('structured_record'));
});

test('read coverage is isolated per need and unselected or untraced records cannot satisfy a need', () => {
  const first = source(), second = source();
  const notice = need();
  const payment: StructuredNeed = { ...need(), id: 'need.payment', spec: { ...need().spec!, topic: 'payment.amount' } };
  const [noticeResult, paymentResult] = evaluate({ needs: [notice, payment], sources: [first, second],
    attempts: [attempt(notice.id, [first]), attempt(payment.id, [second])] });
  assert.deepEqual(noticeResult?.examined, [first]);
  assert.deepEqual(noticeResult?.unread, [second]);
  assert.deepEqual(paymentResult?.examined, [second]);
  const supplied = finding(first);
  assert.equal(evaluate({ sources: [first], findings: [supplied], attempts: [attempt(notice.id, [first])] })[0]?.satisfaction, 'needs_information');
  const foreign = source(), forged = finding(foreign);
  assert.equal(evaluate({ sources: [first], findings: [forged], attempts: [attempt(notice.id, [foreign], [forged])] })[0]?.coverage, 'unread');
});

test('duplicate identifiers and incompatible checksums for the same source version are rejected', () => {
  const selected = source();
  assert.throws(() => evaluate({ needs: [need(), need()], sources: [selected] }), /INFORMATION_NEED_INVALID/);
  assert.throws(() => evaluate({ sources: [selected, { ...selected, textSha256: 'b'.repeat(64) }] }), /INFORMATION_NEED_INVALID/);
});
