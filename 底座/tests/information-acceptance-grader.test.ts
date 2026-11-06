import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { gradeInformationAcceptance } from '../examples/information-demo.ts';
import { acceptanceCases, type InformationAcceptanceCase } from '../examples/fixtures/information-acceptance.ts';
import type { LoopFinding, LoopRun } from '../src/loops/contracts.ts';
import type { InformationRecord } from '../src/information/contracts.ts';

/** Build valid controls; each negative test changes one independently graded property. */
function acceptedRun(fixture: InformationAcceptanceCase): LoopRun {
  const sources = fixture.materials.map((material) => ({ materialId: randomUUID(), versionId: randomUUID(),
    textSha256: createHash('sha256').update(material.text).digest('hex') }));
  const findings: LoopFinding[] = fixture.expected.facts.map((fact) => {
    const material = fixture.materials[fact.sourceIndex]!, source = sources[fact.sourceIndex]!;
    const range = fact.time.allowedRanges[0]!;
    const timeRaw = range.precision === 'date' ? range.start!.replace(/^(\d{4})-(\d{2})-(\d{2})$/u, (_match, year: string, month: string, day: string) => `${year}年${Number(month)}月${Number(day)}日`)
      : fact.time.rawIncludes?.includes('上周') ? '上周'
      : fact.time.rawIncludes?.includes('之后') ? /从主管.+?这次补充说明时/u.exec(material.text)![0] : null;
    const raw = fact.value.kind === 'money' ? `人民币${fact.value.rawIncludes[0]}元` : fact.value.rawIncludes[0]!;
    const record: InformationRecord = {
      topic: fact.topic, subject: structuredClone(fact.subject), object: structuredClone(fact.object), attributedTo: structuredClone(fact.attributedTo),
      event: { type: fact.topic, key: fact.eventKey, description: raw }, time: { raw: timeRaw, ...range },
      value: { kind: fact.value.kind, raw, normalized: fact.value.normalized ?? raw, unit: fact.value.unit },
      polarity: fact.polarity, period: fact.period, basis: fact.basis, origin: material.kind, qualifiers: {}, uncertainty: [],
    };
    return { id: randomUUID(), needId: fact.needId, statement: raw, record,
      citations: [{ ...source, start: 0, end: material.text.length, quote: material.text }] };
  });
  const idsForSource = (index: number) => findings[fixture.expected.facts.findIndex((fact) => fact.sourceIndex === index)]!.id;
  const conflicts = fixture.expected.inconsistentSourcePairs.map(([a, b]) => ({ id: randomUUID(), field: 'value', classification: 'inconsistent' as const,
    findingIds: [idsForSource(a), idsForSource(b)], reason: '同一笔款项的记载金额不同。' }));
  const relations = fixture.expected.equivalentSourcePairs.map(([a, b]) => ({ id: randomUUID(), kind: 'equivalent_claim' as const, status: 'confirmed' as const,
    findingIds: [idsForSource(a), idsForSource(b)], reason: '相同交易条件和金额。' }));
  const provider = { capability: { id: 'test.information', version: 1 }, pluginId: 'test', pluginVersion: '1' };
  return {
    id: randomUUID(), caseId: randomUUID(), baseCaseRevision: 1, goal: fixture.goal,
    createdAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:00:01.000Z', sources,
    providers: { declare: provider, read: provider, review: provider }, limits: { maxRounds: 8, maxReads: 16 }, needs: fixture.needs,
    findings, rounds: [], status: conflicts.length > 0 ? 'needs_review' : 'completed', reason: '评分器测试用例。',
    information: { version: 1, entities: [], conflicts, relations, needs: fixture.needs.map((need) => ({
      needId: need.id, findingIds: findings.filter((finding) => finding.needId === need.id).map((finding) => finding.id), conflictIds: conflicts.map((conflict) => conflict.id),
      coverage: 'found', consistency: conflicts.length > 0 ? 'conflicting' : 'consistent', support: 'statement_only',
      satisfaction: conflicts.length > 0 ? 'needs_review' : 'satisfied', missingFields: [], examined: [...sources], unread: [], reason: '已整理本次提供的事实。', nextActions: [],
    })) },
  };
}
const fixture = (index: number) => acceptanceCases[index]!;

test('independently specified source facts pass all three acceptance controls', async (t) => {
  for (const item of acceptanceCases) await t.test(item.id, () => {
    const result = gradeInformationAcceptance(item, acceptedRun(item));
    assert.equal(result.passed, true, JSON.stringify(result));
  });
});

test('source and finding order do not affect source-specific grading', () => {
  const item = fixture(0), run = acceptedRun(item);
  run.sources.reverse(); run.findings.reverse();
  assert.equal(gradeInformationAcceptance(item, run).passed, true);
});

test('swapped source amounts cannot pass because the global amount set is unchanged', () => {
  const item = fixture(0), run = acceptedRun(item);
  const a = run.findings[0]!.record!, b = run.findings[2]!.record!;
  [a.value, b.value] = [b.value, a.value];
  const result = gradeInformationAcceptance(item, run);
  assert.equal(result.amountValuesMatch, true);
  assert.equal(result.sourceFactsMatch, false);
  assert.equal(result.passed, false);
});

test('wrong conflict source pairs fail even when their total count is correct', () => {
  const item = fixture(0), run = acceptedRun(item);
  run.information!.conflicts[0]!.findingIds = [run.findings[0]!.id, run.findings[1]!.id];
  const result = gradeInformationAcceptance(item, run);
  assert.equal(result.inconsistentSourcePairs, result.expectedInconsistentSourcePairs);
  assert.equal(result.inconsistentSourcePairsMatch, false);
  assert.equal(result.passed, false);
});

test('unsupported extra inconsistency fields do not count as correct monetary conflicts', () => {
  const item = fixture(0), run = acceptedRun(item);
  run.information!.conflicts[0]!.field = 'time';
  assert.equal(gradeInformationAcceptance(item, run).passed, false);
});

test('a wrong equivalent pair is rejected even alongside an adequate correct pair', () => {
  const item = fixture(0), run = acceptedRun(item);
  run.information!.relations.push({ id: randomUUID(), kind: 'equivalent_claim', status: 'confirmed',
    findingIds: [run.findings[0]!.id, run.findings[2]!.id], reason: '错误关联不同金额。' });
  const result = gradeInformationAcceptance(item, run);
  assert.equal(result.sourceFactsMatch, true);
  assert.equal(result.equivalentClaimsValid, false);
  assert.equal(result.passed, false);
});

test('identity, period and basis are checked against their specific source', async (t) => {
  for (const field of ['identity', 'period', 'basis'] as const) await t.test(field, () => {
    const item = fixture(1), run = acceptedRun(item), record = run.findings[0]!.record!;
    if (field === 'identity') record.subject!.identity!.value = 'EMP202';
    else if (field === 'period') record.period = '2025-04';
    else record.basis = '实发';
    const result = gradeInformationAcceptance(item, run);
    assert.equal(result.amountValuesMatch, true);
    assert.equal(result.sourceFactsMatch, false);
    assert.equal(result.passed, false);
  });
});

test('different employee identities cannot be merged by groups or confirmed relations', async (t) => {
  for (const kind of ['group', 'same_entity', 'same_event', 'equivalent_claim'] as const) await t.test(kind, () => {
    const item = fixture(1), run = acceptedRun(item), findingIds = [run.findings[0]!.id, run.findings[1]!.id];
    if (kind === 'group') run.information!.entities.push({ id: randomUUID(), names: ['王琳'], kind: 'person', findingIds });
    else run.information!.relations.push({ id: randomUUID(), kind, status: 'confirmed', findingIds, reason: '错误合并同名员工。' });
    const result = gradeInformationAcceptance(item, run);
    assert.equal(result.sourceFactsMatch, true);
    assert.equal(result.subjectSeparationPreserved, false);
    assert.equal(result.passed, false);
  });
});

test('missing source facts fail despite another source retaining the same amount or oral quotation', async (t) => {
  for (const index of [0, 2]) await t.test(fixture(index).id, () => {
    const item = fixture(index), run = acceptedRun(item);
    run.findings.splice(1, 1);
    const result = gradeInformationAcceptance(item, run);
    assert.equal(result.amountValuesMatch, true);
    assert.ok(result.missingExpectedFacts.length > 0);
    assert.equal(result.passed, false);
  });
});

test('all oral and contact rows must preserve their roles, topic, polarity and temporal scope', async (t) => {
  const changes: Record<string, (run: LoopRun) => void> = {
    'speaker and recollecting party swapped': (run) => { const r = run.findings[0]!.record!; [r.subject, r.attributedTo] = [r.attributedTo, r.subject]; },
    'contact mislabeled as oral speech': (run) => { const f = run.findings[2]!; f.needId = 'acceptance.oral-statement'; f.record!.topic = f.record!.event.type = 'attendance.oral_instruction'; },
    'post-speech interval assigned to speech': (run) => { run.findings[1]!.record!.time = structuredClone(run.findings[2]!.record!.time); },
    'invented absolute date': (run) => { run.findings[0]!.record!.time = { raw: '上周', precision: 'date', start: '2026-10-27', end: '2026-10-27' }; },
    'contact negation lost': (run) => { run.findings[2]!.record!.polarity = 'affirmed'; },
    'contact interval lost': (run) => { run.findings[2]!.record!.time = { ...run.findings[1]!.record!.time }; },
    'bounded no-contact changed to never contacted': (run) => { const value = run.findings[2]!.record!.value; value.raw = value.normalized = '从未联系'; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const item = fixture(2), run = acceptedRun(item); change(run);
    const result = gradeInformationAcceptance(item, run);
    assert.equal(result.sourceFactsMatch, false);
    assert.equal(result.passed, false);
  });
});

test('a correct oral row and no-contact row cannot mask unrelated or nested-negation extras', async (t) => {
  for (const topic of ['attendance.oral_instruction', 'attendance.subsequent_contact']) await t.test(topic, () => {
    const item = fixture(2), run = acceptedRun(item), extra = structuredClone(run.findings[2]!);
    extra.id = randomUUID(); extra.needId = topic === 'attendance.oral_instruction' ? 'acceptance.oral-statement' : 'acceptance.follow-up-arrangement';
    extra.statement = '陈宁称其没有说自己曾收到书面通知。';
    Object.assign(extra.record!, { topic, subject: extra.record!.object, object: null, polarity: 'denied',
      event: { type: topic, key: null, description: '陈宁是否曾收到书面通知' },
      value: { kind: 'boolean', raw: '没有说自己曾收到书面通知', normalized: 'false', unit: null } });
    run.findings.push(extra);
    run.information!.needs.find((need) => need.needId === extra.needId)!.findingIds.push(extra.id);
    const result = gradeInformationAcceptance(item, run);
    assert.equal(result.relativeTimePreserved, true);
    assert.equal(result.denialPreserved, true);
    assert.deepEqual(result.unmatchedFindingIds, [extra.id]);
    assert.equal(result.passed, false);
  });
});

test('citations must still resolve to the original source rather than just carry a valid source hash', () => {
  const item = fixture(2), run = acceptedRun(item);
  run.findings[0]!.citations[0]!.quote = '原文中不存在的句子';
  const result = gradeInformationAcceptance(item, run);
  assert.equal(result.citationsValid, false);
  assert.equal(result.passed, false);
});

test('incomplete analysis cannot pass by omitting a declared need', () => {
  const item = fixture(2), run = acceptedRun(item);
  run.information!.needs.pop();
  assert.equal(gradeInformationAcceptance(item, run).avoidsRepeatedQuestions, false);
  assert.equal(gradeInformationAcceptance(item, run).passed, false);
});

test('amount scenarios must also retain complete source coverage and appropriate review status', async (t) => {
  for (const change of ['missing need', 'unread source', 'wrong status', 'missing finding reference'] as const) await t.test(change, () => {
    const item = fixture(0), run = acceptedRun(item);
    if (change === 'missing need') run.information!.needs = [];
    else if (change === 'unread source') run.information!.needs[0]!.examined.pop();
    else if (change === 'wrong status') run.status = 'completed';
    else run.information!.needs[0]!.findingIds.pop();
    const result = gradeInformationAcceptance(item, run);
    assert.equal(result.sourceFactsMatch, true);
    assert.equal(result.coverageAndStatusMatch, false);
    assert.equal(result.passed, false);
  });
});
