import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { extractInformation, segmentInformationDocuments } from '../src/information/extract.ts';
import { normalizeInformationRecord, normalizeInformationTime, normalizeQuantity } from '../src/information/normalize.ts';
import type { InformationRecord, StructuredNeed } from '../src/information/contracts.ts';
import type { JsonModel } from '../src/information/model.ts';
import type { LoopDocument } from '../src/loops/contracts.ts';

const need: StructuredNeed = { id: 'test.amount', question: '材料记载了什么付款金额？', reason: '核对记载及出处。', spec: {
  topic: 'payment.amount', subject: null, object: null, period: null, basis: null,
  requiredFields: ['value'], minimumSupport: 'statement', applicable: true,
} };
function document(text: string): LoopDocument {
  return { materialId: randomUUID(), versionId: randomUUID(), sourceLabel: '虚构边界测试材料',
    text, textSha256: createHash('sha256').update(text).digest('hex') };
}
function record(overrides: Partial<InformationRecord> = {}): InformationRecord {
  return {
    topic: need.spec!.topic, subject: null, object: null, attributedTo: null,
    event: { type: 'payment', key: null, description: '记载付款金额。' },
    time: { raw: null, start: null, end: null, precision: 'unknown' },
    value: { kind: 'money', raw: '6000元', normalized: '99999', unit: 'USD' },
    polarity: 'affirmed', period: null, basis: null, origin: 'party_statement', qualifiers: {}, uncertainty: [],
    ...overrides,
  };
}
type SegmentInput = { needs: StructuredNeed[]; segment: { id: string; text: string; sourceLabel: string; sourceKind: string }; rejectedOutput?: unknown; feedback?: string };
function model(handler: (payload: SegmentInput, input: Parameters<JsonModel['complete']>[0]) => unknown | Promise<unknown>) {
  const calls: Parameters<JsonModel['complete']>[0][] = [];
  const provider: JsonModel = { id: 'test-json-only', model: 'fixture', complete: async (input) => {
    calls.push(input); return handler(JSON.parse(input.user) as SegmentInput, input);
  } };
  return { provider, calls };
}
function item(segment: SegmentInput['segment'], details = record(), quote = segment.text, occurrence: number | null = null) {
  return { statement: `材料记载：${quote}`, record: details, quotes: [{ segmentId: segment.id, quote, occurrence }] };
}
const hasCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;

test('extraction binds structured candidate fields to exact source excerpts and overrides invented canonical values', async () => {
  const text = '张三（工号E001）说：2025年9月1日向星桥公司付款，流水号T001，实付人民币1.25万元。';
  const doc = document(text);
  const person = { name: '张三', kind: 'person' as const, identity: { scheme: 'employee', value: 'E001' } };
  const { provider, calls } = model(({ segment }) => ({ items: [item(segment, record({
    subject: person, attributedTo: person, object: { name: '星桥公司', kind: 'organization', identity: null },
    event: { type: 'payment', key: 'T001', description: '张三向星桥公司付款。' },
    time: { raw: '2025年9月1日', start: '2099-01-01', end: '2099-01-01', precision: 'date' },
    value: { kind: 'money', raw: '人民币1.25万元', normalized: '7000', unit: 'USD' }, period: '2025-09', basis: '实付',
  }))] }));
  const result = await extractInformation(provider, [doc], [need]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.system, /json/iu);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.examined, [{ materialId: doc.materialId, versionId: doc.versionId, textSha256: doc.textSha256 }]);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.record.subject?.identity?.value, 'E001');
  assert.equal(candidate.record.event.key, 'T001');
  assert.equal(candidate.record.time.start, '2025-09-01');
  assert.equal(candidate.record.period, '2025-09');
  assert.equal(candidate.record.value.normalized, '12500');
  assert.equal(candidate.record.value.unit, 'CNY');
  assert.deepEqual(candidate.citations, [{ materialId: doc.materialId, versionId: doc.versionId, textSha256: doc.textSha256,
    start: 0, end: text.length, quote: text }]);
});

test('an inspected source with no relevant records returns zero candidates rather than fabricated defaults', async () => {
  const doc = document('这里只记载材料名称，没有记载本次需求的金额。');
  const { provider } = model(() => ({ items: [] }));
  const result = await extractInformation(provider, [doc], [need]);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.examined.length, 1);
  assert.equal(result.examined[0]?.versionId, doc.versionId);
});

test('segmented reading preserves original absolute offsets and never cuts surrogate pairs', async () => {
  const text = `${'无关背景。'.repeat(50)}\n金额为6000元。`;
  const doc = document(text);
  const segments = segmentInformationDocuments([doc], 100);
  assert.ok(segments.length > 1);
  assert.equal(segments.map((segment) => segment.text).join(''), text);
  const { provider, calls } = model(({ segment }) => ({
    items: segment.text.includes('金额为6000元。') ? [item(segment, record(), '金额为6000元。')] : [],
  }));
  const result = await extractInformation(provider, [doc], [need], { maxSegmentChars: 100 });
  assert.equal(calls.length, segments.length);
  assert.equal(result.candidates.length, 1);
  const citation = result.candidates[0]!.citations[0]!;
  assert.equal(citation.start, text.indexOf('金额为6000元。'));
  assert.equal(text.slice(citation.start, citation.end), citation.quote);
  const emoji = document(`${'x'.repeat(99)}😀${'y'.repeat(110)}`);
  const emojiSegments = segmentInformationDocuments([emoji], 100);
  assert.equal(emojiSegments.map((segment) => segment.text).join(''), emoji.text);
  for (const segment of emojiSegments) {
    assert.equal(/^[\udc00-\udfff]/u.test(segment.text), false);
    assert.equal(/[\ud800-\udbff]$/u.test(segment.text), false);
  }
});

test('repeated excerpts require an explicit occurrence and the chosen occurrence retains its original range', async () => {
  const doc = document('第一处：工资6000元；第二处：工资6000元。');
  const quote = '工资6000元';
  const ambiguous = model(({ segment }) => ({ items: [item(segment, record(), quote)] }));
  await assert.rejects(extractInformation(ambiguous.provider, [doc], [need]), hasCode('INFORMATION_QUOTE_INVALID'));
  const explicit = model(({ segment }) => ({ items: [item(segment, record(), quote, 1)] }));
  const result = await extractInformation(explicit.provider, [doc], [need]);
  assert.equal(result.candidates[0]!.citations[0]!.start, doc.text.lastIndexOf(quote));
  const missingOccurrence = model(({ segment }) => ({ items: [item(segment, record(), quote, 2)] }));
  await assert.rejects(extractInformation(missingOccurrence.provider, [doc], [need]), hasCode('INFORMATION_QUOTE_INVALID'));
});

test('invented, foreign-segment and surrogate-splitting excerpts are rejected before records are admitted', async (t) => {
  const doc = document('🙂张三记载6000元。');
  for (const kind of ['invented', 'foreign-segment', 'split-emoji']) await t.test(kind, async () => {
    const { provider } = model(({ segment }) => {
      const candidate = item(segment, record(), kind === 'split-emoji' ? '\ud83d' : kind === 'invented' ? '8000元' : segment.text);
      if (kind === 'foreign-segment') candidate.quotes[0]!.segmentId = 'outside-current-segment';
      return { items: [candidate] };
    });
    await assert.rejects(extractInformation(provider, [doc], [need]), kind === 'split-emoji'
      ? hasCode('LOOP_CITATION_INVALID') : hasCode('INFORMATION_QUOTE_INVALID'));
  });
});

test('undeclared topics and unsupported raw fields cannot be laundered through a valid quotation', async (t) => {
  const doc = document('张三（工号E001）于2025年9月1日记载流水号T001，实付6000元。');
  const changes: { name: string; code: string; value: Partial<InformationRecord> }[] = [
    { name: 'topic', code: 'INFORMATION_TOPIC_INVALID', value: { topic: 'invented.legal-conclusion' } },
    { name: 'person', code: 'INFORMATION_UNGROUNDED_FIELD', value: { subject: { name: '李四', kind: 'person', identity: null } } },
    { name: 'identity', code: 'INFORMATION_UNGROUNDED_FIELD', value: { subject: { name: '张三', kind: 'person', identity: { scheme: 'employee', value: 'E999' } } } },
    { name: 'event key', code: 'INFORMATION_UNGROUNDED_FIELD', value: { event: { type: 'payment', key: 'T999', description: '付款' } } },
    { name: 'raw value', code: 'INFORMATION_UNGROUNDED_FIELD', value: { value: { kind: 'money', raw: '8000元', normalized: '8000', unit: 'CNY' } } },
    { name: 'basis', code: 'INFORMATION_UNGROUNDED_FIELD', value: { basis: '税后' } },
    { name: 'time', code: 'INFORMATION_UNGROUNDED_FIELD', value: { time: { raw: '2026年1月1日', start: '2026-01-01', end: '2026-01-01', precision: 'date' } } },
  ];
  for (const change of changes) await t.test(change.name, async () => {
    const { provider } = model(({ segment }) => ({ items: [item(segment, record(change.value))] }));
    await assert.rejects(extractInformation(provider, [doc], [need]), hasCode(change.code));
  });
});

test('relative time and unsupported values remain unresolved even if the model supplies convenient canonical answers', async () => {
  const doc = document('张三说上周收到的金额约6000元。');
  const { provider } = model(({ segment }) => ({ items: [item(segment, record({
    subject: { name: '张三', kind: 'person', identity: null },
    time: { raw: '上周', start: '2025-01-01', end: '2025-01-07', precision: 'range' },
    value: { kind: 'money', raw: '约6000元', normalized: '6000', unit: 'CNY' }, period: '2025-01',
  }))] }));
  const result = await extractInformation(provider, [doc], [need]);
  const actual = result.candidates[0]!.record;
  assert.deepEqual(actual.time, { raw: '上周', start: null, end: null, precision: 'relative' });
  assert.equal(actual.value.normalized, null);
  assert.equal(actual.period, null);
  assert.ok(actual.uncertainty.includes('time_not_resolved'));
  assert.ok(actual.uncertainty.includes('value_not_resolved'));
  assert.ok(actual.uncertainty.includes('period_not_resolved'));
  assert.ok(actual.uncertainty.includes('approximate_or_ranged_value'));
});

test('decimal, thousand and ten-thousand amounts normalize exactly while unsupported expressions stay unknown', () => {
  const cases = [
    ['1.2300万元', '12300', 'CNY'], ['0.0001万元', '1', 'CNY'], ['1.25千元', '1250', 'CNY'],
    ['人民币1,234.50元', '1234.5', 'CNY'], ['1.01万港元', '10100', 'HKD'], ['1.00美元', '1', 'USD'],
    ['0.10元', '0.1', 'CNY'], ['-0.00元', '0', 'CNY'],
  ] as const;
  for (const [raw, normalized, unit] of cases) assert.deepEqual(normalizeQuantity(raw, true), { normalized, unit });
  for (const raw of ['六千元', '约6000元', '5000至6000元']) assert.deepEqual(normalizeQuantity(raw, true), { normalized: null, unit: null });
  assert.deepEqual(normalizeInformationTime('2025年9月'), { raw: '2025年9月', start: '2025-09-01', end: '2025-09-30', precision: 'month' });
  assert.equal(normalizeInformationTime('2025年2月30日').start, null);
  const unknownBoolean = normalizeInformationRecord(record({ value: { kind: 'boolean', raw: '大概已经到账', normalized: 'true', unit: null } }), '大概已经到账');
  assert.equal(unknownBoolean.value.normalized, null);
});

test('ordinary text containing 到 or 约 is not incorrectly marked as an approximate numeric value', () => {
  for (const raw of ['没有收到', '收到约定的通知', '截至昨日仍未联系']) {
    const normalized = normalizeInformationRecord(record({
      value: { kind: 'text', raw, normalized: null, unit: null }, polarity: 'denied',
    }), raw);
    assert.equal(normalized.value.normalized, raw);
    assert.equal(normalized.polarity, 'denied');
    assert.deepEqual(normalized.uncertainty, []);
  }
  const approximateNumber = normalizeInformationRecord(record({
    value: { kind: 'number', raw: '约6000', normalized: '6000', unit: null },
  }), '约6000');
  assert.ok(approximateNumber.uncertainty.includes('approximate_or_ranged_value'));
});

test('source classification comes from explicit input rather than a model promoting its own claims to documentary support', async () => {
  const doc = document('6000元。');
  const modelOrigin = (origin: InformationRecord['origin']) => model(({ segment }) => ({ items: [item(segment, record({ origin }))] })).provider;
  const defaultKind = await extractInformation(modelOrigin('document_record'), [doc], [need]);
  assert.equal(defaultKind.candidates[0]!.record.origin, 'party_statement');
  const explicitKind = await extractInformation(modelOrigin('party_statement'), [doc], [need], { sourceKinds: { [doc.materialId]: 'document_record' } });
  assert.equal(explicitKind.candidates[0]!.record.origin, 'document_record');
  const inferred = await extractInformation(modelOrigin('inference'), [doc], [need], { sourceKinds: { [doc.materialId]: 'document_record' } });
  assert.equal(inferred.candidates[0]!.record.origin, 'inference');
  assert.ok(inferred.candidates[0]!.record.uncertainty.includes('inference_requires_review'));
});

test('input and cancellation limits fail explicitly instead of truncating or accepting late extraction results', async () => {
  const doc = document('6000元。');
  const simple = model(({ segment }) => ({ items: [item(segment)] }));
  await assert.rejects(extractInformation(simple.provider, [doc], [need], { maxSegments: NaN }));
  assert.equal(simple.calls.length, 0);
  const controller = new AbortController();
  const cancelled = model(({ segment }, input) => {
    assert.strictEqual(input.signal, controller.signal);
    controller.abort('private caller reason');
    return { items: [item(segment)] };
  });
  await assert.rejects(extractInformation(cancelled.provider, [doc], [need], { signal: controller.signal }));
});

test('qualifiers that can alter comparison scope must not introduce a date or condition absent from the quoted evidence', async () => {
  const doc = document('张三记载6000元。');
  const unsupported = model(({ segment }) => ({ items: [item(segment, record({ qualifiers: { asOf: '2099-01-01' } }))] }));
  await assert.rejects(extractInformation(unsupported.provider, [doc], [need]), hasCode('INFORMATION_UNGROUNDED_FIELD'));
});

test('a narrow excerpt gains exact same-segment context for an explicitly named actor and identity', async () => {
  const text = '我叫陈宁，工号W017。关于付款，我当时说：“实付6000元。”';
  const quote = '实付6000元。';
  const doc = document(text);
  const actor = { name: '陈宁', kind: 'person' as const, identity: { scheme: '工号', value: 'W017' } };
  const { provider, calls } = model(({ segment }) => ({ items: [item(segment, record({
    subject: actor, attributedTo: actor, basis: '实付',
  }), quote)] }));
  const result = await extractInformation(provider, [doc], [need]);
  assert.equal(calls.length, 1);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.record.subject?.identity?.scheme, 'employee_id');
  assert.equal(candidate.record.attributedTo?.name, '陈宁');
  assert.deepEqual(candidate.citations, [
    { materialId: doc.materialId, versionId: doc.versionId, textSha256: doc.textSha256,
      start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote },
    { materialId: doc.materialId, versionId: doc.versionId, textSha256: doc.textSha256,
      start: 0, end: text.length, quote: text },
  ]);
  for (const citation of candidate.citations) assert.equal(text.slice(citation.start, citation.end), citation.quote);
});

test('context citation does not rescue a fabricated actor absent from the entire provided segment', async () => {
  const doc = document('我叫陈宁，工号W017。我记载：“实付6000元。”');
  const { provider, calls } = model(({ segment }) => ({ items: [item(segment, record({
    subject: { name: '陈宁', kind: 'person', identity: { scheme: 'employee_id', value: 'W017' } },
    attributedTo: { name: '赵敏', kind: 'person', identity: null },
  }), '实付6000元。')] }));
  await assert.rejects(extractInformation(provider, [doc], [need], { maxRepairAttempts: 0 }), hasCode('INFORMATION_UNGROUNDED_FIELD'));
  assert.equal(calls.length, 1);
});

test('a name in an unread segment cannot be used as automatic context for the current segment', async () => {
  const doc = document(`陈宁（工号W017）。${'背景说明。'.repeat(25)}\n6000元。`);
  const segments = segmentInformationDocuments([doc], 100);
  const amountSegment = segments.find((segment) => segment.text.includes('6000元。'))!;
  assert.ok(!amountSegment.text.includes('陈宁'));
  const { provider } = model(({ segment }) => ({ items: segment.text.includes('6000元。') ? [item(segment, record({
    subject: { name: '陈宁', kind: 'person', identity: { scheme: 'employee_id', value: 'W017' } },
  }), '6000元。')] : [] }));
  await assert.rejects(extractInformation(provider, [doc], [need], { maxSegmentChars: 100, maxRepairAttempts: 0 }), hasCode('INFORMATION_UNGROUNDED_FIELD'));
});

test('normalization removes only redundant canonical qualifiers and remains idempotent with real extra conditions', () => {
  const evidence = '2025年4月16日流水号TX01，所属期间2025年4月，实付人民币1.25万元；截至2025年4月30日，渠道为网银。';
  const input = record({
    event: { type: 'payment', key: 'TX01', description: '实付款项。' },
    time: { raw: '2025年4月16日', start: null, end: null, precision: 'unknown' },
    value: { kind: 'money', raw: '人民币1.25万元', normalized: null, unit: null },
    period: '2025-04', basis: '实付',
    qualifiers: { 币种: '人民币', 所属期间: '2025年4月', 金额口径: '实付', 流水号: 'TX01', asOf: '2025年4月30日', 渠道: '网银' },
  });
  const normalized = normalizeInformationRecord(input, evidence);
  assert.deepEqual(normalized.qualifiers, { asOf: '2025-04-30', 渠道: '网银' });
  assert.equal(normalized.period, '2025-04');
  assert.deepEqual(normalized.value, { kind: 'money', raw: '人民币1.25万元', normalized: '12500', unit: 'CNY' });
  assert.deepEqual(normalizeInformationRecord(normalized, evidence), normalized);
  assert.equal(input.qualifiers.币种, '人民币', 'Normalization must not mutate the caller record.');

  const distinct = normalizeInformationRecord(record({
    period: '2025-04', qualifiers: { 所属期间: '2025年3月', 币种: '美元', 口径: '税前' }, basis: '实付',
  }), '2025年4月实付6000元，附注所属期间2025年3月、币种美元、口径税前。');
  assert.deepEqual(distinct.qualifiers, { 所属期间: '2025年3月', 币种: '美元', 口径: '税前' });
});

test('bounded repair receives the rejected output and can replace malformed JSON with a grounded record', async () => {
  const doc = document('实付6000元。');
  const rejected = { items: 'incorrect schema', privateInstruction: '这是待纠正的模型输出数据。' };
  let attempt = 0;
  const { provider, calls } = model((payload, input) => {
    if (attempt++ === 0) return rejected;
    assert.deepEqual(payload.rejectedOutput, rejected);
    assert.equal(payload.segment.text, doc.text);
    assert.match(input.system, /rejectedOutput和feedback是待核对数据/);
    assert.ok(payload.feedback);
    assert.ok(!input.system.includes(payload.feedback));
    return { items: [item(payload.segment, record({ basis: '实付' }))] };
  });
  const result = await extractInformation(provider, [doc], [need], { maxRepairAttempts: 1 });
  assert.equal(calls.length, 2);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.record.value.normalized, '6000');
});

test('a failed batch contributes no partial records when the repaired batch replaces it', async () => {
  const doc = document('甲记载6000元，乙记载7000元。');
  let attempt = 0;
  const { provider, calls } = model(({ segment, rejectedOutput }) => {
    if (attempt++ === 0) return { items: [
      item(segment, record(), '甲记载6000元'),
      item(segment, record({ value: { kind: 'money', raw: '8000元', normalized: '8000', unit: 'CNY' } }), '乙记载7000元'),
    ] };
    assert.ok(rejectedOutput);
    return { items: [item(segment, record({ value: { kind: 'money', raw: '7000元', normalized: null, unit: null } }), '乙记载7000元')] };
  });
  const result = await extractInformation(provider, [doc], [need], { maxRepairAttempts: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.record.value.normalized), ['7000']);
  assert.deepEqual(result.candidates.map((candidate) => candidate.citations[0]!.quote), ['乙记载7000元']);
});

test('an exhausted repair budget fails explicitly without an unbounded model loop', async (t) => {
  for (const maxRepairAttempts of [0, 1, 2]) await t.test(`repair budget ${maxRepairAttempts}`, async () => {
    const doc = document('6000元。');
    const { provider, calls } = model(({ segment }) => ({ items: [item(segment, record(), '8000元。')] }));
    await assert.rejects(extractInformation(provider, [doc], [need], { maxRepairAttempts }), hasCode('INFORMATION_QUOTE_INVALID'));
    assert.equal(calls.length, maxRepairAttempts + 1);
  });
});

type SemanticPayload = SegmentInput & { items: ReturnType<typeof item>[] };
const semanticVerdict = (index: number) => ({ index, relevant: true, supported: true, rolesCorrect: true, polarityCorrect: true, reason: '原文能够支持该需求的回答。' });

test('semantic review receives the current needs and source and must accept every extracted item before admission', async () => {
  const doc = document('甲记载6000元，乙记载7000元。');
  const { provider, calls } = model((payload, input) => {
    if (input.system.includes('INFORMATION_SEMANTIC_REVIEW')) {
      assert.equal(input.reasoning, 'high');
      const review = payload as SemanticPayload;
      assert.deepEqual(review.needs, [need]);
      assert.equal(review.segment.text, doc.text);
      assert.equal(review.items.length, 2);
      for (const candidate of review.items) assert.equal(candidate.quotes[0]!.segmentId, review.segment.id);
      return { verdicts: [semanticVerdict(1), semanticVerdict(0)] };
    }
    assert.equal(input.reasoning, undefined, 'Initial extraction does not require high reasoning.');
    return { items: [
      item(payload.segment, record(), '甲记载6000元'),
      item(payload.segment, record({ value: { kind: 'money', raw: '7000元', normalized: '1', unit: 'USD' } }), '乙记载7000元'),
    ] };
  });
  const result = await extractInformation(provider, [doc], [need], { verifySemantics: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.record.value.normalized), ['6000', '7000']);
});

test('an irrelevant or polarity-wrong item rejects its entire batch and a bounded retry can replace it', async (t) => {
  for (const flag of ['relevant', 'polarityCorrect'] as const) await t.test(flag, async () => {
    const doc = document('这里记载6000元，补充另一笔7000元。');
    let extractionAttempts = 0, reviewAttempts = 0;
    const { provider, calls } = model((payload, input) => {
      if (input.system.includes('INFORMATION_SEMANTIC_REVIEW')) {
        const review = payload as SemanticPayload;
        reviewAttempts += 1;
        return { verdicts: review.items.map((_, index) => ({ ...semanticVerdict(index),
          ...(reviewAttempts === 1 && index === 1 ? { [flag]: false, reason: '第二条未忠实回答当前需求。' } : {}),
        })) };
      }
      extractionAttempts += 1;
      if (extractionAttempts === 1) return { items: [
        item(payload.segment, record(), '这里记载6000元'),
        item(payload.segment, record({ polarity: flag === 'polarityCorrect' ? 'denied' : 'affirmed',
          value: { kind: 'money', raw: '7000元', normalized: null, unit: null } }), '补充另一笔7000元'),
      ] };
      assert.ok(payload.rejectedOutput);
      assert.match(payload.feedback ?? '', /INFORMATION_SEMANTIC_REJECTED.*第二条未忠实回答当前需求/);
      assert.doesNotMatch(input.system, /第二条未忠实回答当前需求/);
      return { items: [item(payload.segment, record({ value: { kind: 'money', raw: '7000元', normalized: null, unit: null } }), '补充另一笔7000元')] };
    });
    const result = await extractInformation(provider, [doc], [need], { verifySemantics: true, maxRepairAttempts: 1 });
    assert.equal(calls.length, 4);
    assert.equal(extractionAttempts, 2);
    assert.equal(reviewAttempts, 2);
    assert.deepEqual(result.candidates.map((candidate) => candidate.record.value.normalized), ['7000']);
    assert.equal(result.candidates[0]!.record.polarity, 'affirmed');
  });
});

test('each failed semantic dimension prevents an otherwise grounded record from being admitted', async (t) => {
  for (const flag of ['relevant', 'supported', 'rolesCorrect', 'polarityCorrect'] as const) await t.test(flag, async () => {
    const doc = document('6000元。');
    const { provider, calls } = model((payload, input) => input.system.includes('INFORMATION_SEMANTIC_REVIEW')
      ? { verdicts: [{ ...semanticVerdict(0), [flag]: false, reason: '当前条目需重新核对。' }] }
      : { items: [item(payload.segment)] });
    await assert.rejects(extractInformation(provider, [doc], [need], { verifySemantics: true, maxRepairAttempts: 0 }), hasCode('INFORMATION_SEMANTIC_REJECTED'));
    assert.equal(calls.length, 2);
  });
});

test('missing, duplicate, out-of-range and malformed semantic verdicts fail closed', async (t) => {
  const responses: Record<string, unknown> = {
    'missing verdict': { verdicts: [] },
    'duplicate index': { verdicts: [semanticVerdict(0), semanticVerdict(0)] },
    'foreign index': { verdicts: [semanticVerdict(1)] },
    'missing dimension': { verdicts: [{ index: 0, relevant: true, supported: true, rolesCorrect: true, reason: '遗漏肯否判断。' }] },
    'non-boolean dimension': { verdicts: [{ ...semanticVerdict(0), relevant: 'true' }] },
    'wrong shape': { accepted: true },
  };
  for (const [name, response] of Object.entries(responses)) await t.test(name, async () => {
    const doc = document('6000元。');
    const { provider, calls } = model((payload, input) => input.system.includes('INFORMATION_SEMANTIC_REVIEW')
      ? response : { items: [item(payload.segment)] });
    await assert.rejects(extractInformation(provider, [doc], [need], { verifySemantics: true, maxRepairAttempts: 0 }), hasCode('INFORMATION_SEMANTIC_INVALID'));
    assert.equal(calls.length, 2);
  });
});

test('cancellation during semantic review rejects a late accepted result', async () => {
  const controller = new AbortController();
  const doc = document('6000元。');
  const { provider, calls } = model((payload, input) => {
    assert.strictEqual(input.signal, controller.signal);
    if (input.system.includes('INFORMATION_SEMANTIC_REVIEW')) {
      controller.abort('caller stopped');
      return { verdicts: [semanticVerdict(0)] };
    }
    return { items: [item(payload.segment)] };
  });
  await assert.rejects(extractInformation(provider, [doc], [need], {
    verifySemantics: true, maxRepairAttempts: 0, signal: controller.signal,
  }), hasCode('INFORMATION_CANCELLED'));
  assert.equal(calls.length, 2);
});
