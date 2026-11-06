import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { NeedCoverage } from '../src/information/contracts.ts';
import type { LoopFinding, LoopRun, LoopSource } from '../src/loops/contracts.ts';
import { buildNodeReview, nodeReviewLines, type NodePreparation } from '../src/node-review/index.ts';

const caseId = randomUUID();
const need = { id: 'lease.delivery', question: '交付日期及双方如何记载？', reason: '核对交付事项。' };
const profile = { id: 'lease', version: '1', profileId: 'lease.intake' };
const provider = { capability: { id: 'fixture', version: 1 }, pluginId: 'fixture', pluginVersion: '1' };

function source(text: string, materialId: string = randomUUID()): LoopSource {
  return { materialId, versionId: randomUUID(), textSha256: createHash('sha256').update(text).digest('hex') };
}
function finding(at: LoopSource, quote: string, day = '2026-10-03'): LoopFinding {
  return { id: randomUUID(), needId: need.id, statement: quote,
    citations: [{ ...at, start: 0, end: quote.length, quote }],
    record: {
      topic: 'lease.delivery.date', subject: { name: '甲公司', kind: 'organization', identity: { scheme: 'registry', value: 'A01' } },
      object: null, attributedTo: null, event: { type: 'lease.delivery', key: 'X-01', description: '交付房屋' },
      time: { raw: day, start: day, end: day, precision: 'date' },
      value: { kind: 'date', raw: day, normalized: day, unit: null },
      polarity: 'affirmed', period: null, basis: null, origin: 'document_record', qualifiers: {}, uncertainty: [],
    } };
}
function run(revision: number, sources: LoopSource[], findings: LoopFinding[], coverage?: Partial<NeedCoverage>): LoopRun {
  return { id: randomUUID(), caseId, baseCaseRevision: revision, createdAt: '2026-10-06T06:00:00.000Z',
    finishedAt: '2026-10-06T06:00:00.000Z', goal: '核对交付', reason: '已检查材料',
    sources, findings, needs: [need], status: 'completed', limits: { maxRounds: 2, maxReads: 10 },
    providers: { declare: provider, read: provider, review: provider }, rounds: [],
    information: { version: 1, entities: [], relations: [], conflicts: [],
      needs: [{ needId: need.id, coverage: 'found', consistency: 'consistent', support: 'document_supported',
        satisfaction: 'satisfied', examined: sources, unread: [], missingFields: [],
        findingIds: findings.map((item) => item.id), conflictIds: [], reason: '已检查', nextActions: [], ...coverage }] },
  };
}

test('节点审查对照固定版本、同文副本和同一结构化记录的新出处', () => {
  const a = source('交付日为 2026-10-03。');
  const old = source('需要补充核对交付。');
  const corrected = source('补充了交付记载。', old.materialId);
  const removed = source('历史便笺。');
  const copy = source('交付日为 2026-10-03。');
  const first = finding(a, '交付日为 2026-10-03。');
  const carried = { ...structuredClone(first), id: randomUUID(), statement: '交付发生在十月三日。' };
  const currentCopy = finding(copy, '交付日为 2026-10-03。');
  const baseline = run(2, [a, old, removed], [first]);
  const current = run(4, [a, corrected, copy], [carried, currentCopy]);
  const review = buildNodeReview({ kind: 'new_evidence', baseline, current, currentScope: current.sources });
  assert.equal(review.status, 'ready_for_review');
  assert.deepEqual(review.sources.map((item) => item.kind), ['version_changed', 'left_selection', 'added']);
  assert.deepEqual(review.sources[2]!.duplicateContent, [a]);
  assert.equal(review.facts.length, 1);
  assert.equal(review.facts[0]!.kind, 'evidence_changed');
  assert.deepEqual(review.facts[0]!.after.map((item) => item.citations[0]!.materialId), [a.materialId, copy.materialId]);
  assert.match(nodeReviewLines(review).join('\n'), /同文来源.*交付日为 2026-10-03/su);
  const reextracted = buildNodeReview({ kind: 'new_evidence', baseline, current: run(4, [a, old, removed], [carried]), currentScope: baseline.sources });
  assert.deepEqual(reextracted.facts, []);
});

test('相反记载、专业判断变化与准备事项保留两侧证据', () => {
  const a = source('交付日是 10 月 3 日。');
  const b = source('交付日是 10 月 5 日。');
  const f1 = finding(a, '交付日是 10 月 3 日。');
  const f2 = finding(b, '交付日是 10 月 5 日。', '2026-10-05');
  const baseline = run(2, [a], [f1]);
  baseline.professionalReview = { reviewer: profile, decision: 'ready', actions: [],
    assessments: [{ checkId: 'lease.delivery.fact', state: 'supported', reason: '有一方材料', findingIds: [f1.id] }] };
  const current = run(4, [a, b], [f1, f2], { satisfaction: 'needs_review', consistency: 'conflicting' });
  current.status = 'needs_review';
  current.information!.conflicts.push({ id: 'date-conflict', classification: 'inconsistent', field: 'date',
    reason: '同一交付事项的日期相反。', findingIds: [f1.id, f2.id] });
  current.professionalReview = { reviewer: profile, decision: 'human_review',
    actions: [{ kind: 'human_review', needId: need.id, checkId: 'lease.delivery.fact', reason: '日期相反', instruction: '核对交接凭证' }],
    assessments: [{ checkId: 'lease.delivery.fact', state: 'conflicting', reason: '日期相反', findingIds: [f1.id, f2.id] }] };
  const review = buildNodeReview({ kind: 'opponent_response', baseline, current, currentScope: current.sources });
  assert.equal(review.status, 'requires_review');
  assert.equal(review.professional.changes[0]!.before!.state, 'supported');
  assert.equal(review.professional.changes[0]!.after!.state, 'conflicting');
  assert.deepEqual(review.conflicts[0]!.after!.evidence.map((item) => item.citations[0]!.quote), [f1.statement, f2.statement]);
  assert.ok(review.preparations.some((item) => item.instruction === '核对交接凭证'));
  const incomplete = run(6, [b], [f2]);
  const later = buildNodeReview({ kind: 'new_evidence', baseline: current, current: incomplete, currentScope: [b] });
  assert.equal(later.status, 'requires_review');
  assert.equal(later.conflicts[0]!.kind, 'not_carried_forward');
  assert.ok(later.preparations.some((item) => item.baselineFindingIds.includes(f1.id)));
});

test('未读范围和已检查未见记载分别保存，遗漏来源阻止标成可交复核', () => {
  const a = source('一份便笺。');
  const b = source('尚未选入的新增材料。');
  const baseline = run(2, [a], [], { coverage: 'unread', satisfaction: 'needs_information', support: 'none', unread: [a], examined: [] });
  const current = run(4, [a], [], { coverage: 'not_found_in_examined', satisfaction: 'needs_information', support: 'none' });
  current.status = 'needs_review';
  const review = buildNodeReview({ kind: 'new_evidence', baseline, current, currentScope: [a, b] });
  assert.deepEqual(review.scope.missingSources, [b]);
  assert.equal(review.coverage[0]!.before!.coverage, 'unread');
  assert.equal(review.coverage[0]!.after!.coverage, 'not_found_in_examined');
  assert.equal(review.status, 'requires_review');
  assert.ok(review.preparations.some((item) => item.kind === 'read' && item.sources[0]?.materialId === b.materialId));
});

test('同一事件编号不能抵消符号、记录期间及需求适用范围的差异', () => {
  const a = source('同编号的前后陈述。');
  const first = finding(a, '同编号的前后陈述。');
  first.record!.period = '2026-09';
  const second = structuredClone(first);
  second.id = randomUUID();
  second.record!.period = '2026-10';
  second.record!.polarity = 'denied';
  const baseline = run(2, [a], [first]);
  const current = run(4, [a], [second]);
  const review = buildNodeReview({ kind: 'opponent_response', baseline, current, currentScope: [a] });
  assert.deepEqual(review.facts.map((item) => item.kind), ['not_carried_forward', 'new_record']);
  assert.deepEqual(review.conflicts, []);
  assert.equal(review.facts[1]!.after[0]!.record?.period, '2026-10');
  assert.equal(review.facts[1]!.after[0]!.record?.polarity, 'denied');

  const spec = { topic: 'lease.delivery.date', subject: null, object: null, basis: null,
    requiredFields: [], minimumSupport: 'statement' as const, applicable: true };
  baseline.needs = [{ ...need, spec: { ...spec, period: '2026-09' } }];
  current.findings = [structuredClone(first)];
  current.needs = [{ ...need, spec: { ...spec, period: '2026-10' } }];
  const changedScope = buildNodeReview({ kind: 'opponent_response', baseline, current, currentScope: [a] });
  assert.equal(changedScope.coverage[0]!.definitionChanged, true);
  assert.deepEqual(changedScope.facts.map((item) => item.kind), ['not_carried_forward', 'new_record']);
});

test('同一有效运行可做庭前准备，跨案、逆序或不实的同一运行拒绝', () => {
  const a = source('交付日为 2026-10-03。');
  const previous = run(2, [a], [finding(a, '交付日为 2026-10-03。')]);
  const current = run(4, [a], []);
  const review = buildNodeReview({ kind: 'hearing_preparation', baseline: current, current, currentScope: [a] });
  assert.equal(review.kind, 'hearing_preparation');
  assert.deepEqual(review.facts, []);
  assert.ok(review.preparations.some((item) => item.kind === 'prepare' && item.instruction.includes('庭前')));
  const unreadMaterialIds = [randomUUID()];
  const unparsedAttachmentIds = [randomUUID()];
  const unparsed = buildNodeReview({ kind: 'hearing_preparation', baseline: current, current, currentScope: [a],
    unreadMaterialIds, unparsedAttachmentIds });
  assert.equal(unparsed.status, 'requires_review');
  assert.deepEqual(unparsed.scope.unreadMaterialIds, unreadMaterialIds);
  assert.deepEqual(unparsed.scope.unparsedAttachmentIds, unparsedAttachmentIds);
  assert.ok(unparsed.preparations.some((item) => item.kind === 'read' && item.instruction.includes('未解析附件')));
  assert.match(nodeReviewLines(unparsed).join('\n'), /尚无文字版本.*未解析附件/su);
  for (const pair of [
    { baseline: previous, current: { ...current, caseId: randomUUID() } },
    { baseline: current, current: previous },
    { baseline: current, current },
  ]) assert.throws(() => buildNodeReview({ kind: 'new_evidence', ...pair }), /NODE_REVIEW_RUN_INVALID/u);
  assert.throws(() => buildNodeReview({ kind: 'hearing_preparation', baseline: current, current: { ...current, goal: '同 ID 的不同记录' } }),
    /NODE_REVIEW_RUN_INVALID/u);
});

test('领域插件可补入合法待办，越界引用或撞名无法通过', () => {
  const a = source('交付日为 2026-10-03。');
  const f = finding(a, '交付日为 2026-10-03。');
  const current = run(4, [a], [f]);
  const input = { kind: 'hearing_preparation' as const, baseline: current, current, currentScope: [a] };
  const action: NodePreparation = { id: 'lease.hearing', kind: 'human_review', needIds: [need.id],
    instruction: '核对交接单原件的签字。', reason: '领域准备事项。', currentFindingIds: [f.id], baselineFindingIds: [], sources: [a] };
  const review = buildNodeReview({ ...input, contribute: () => [action] });
  assert.equal(review.status, 'requires_review');
  assert.deepEqual(review.preparations.at(-1), action);
  assert.throws(() => buildNodeReview({ ...input, contribute: () => [{ ...action, currentFindingIds: [randomUUID()] }] }),
    /NODE_REVIEW_CONTRIBUTION_INVALID/u);
  assert.throws(() => buildNodeReview({ ...input, contribute: () => [{ ...action, id: 'base.1' }] }),
    /NODE_REVIEW_CONTRIBUTION_INVALID/u);
});
