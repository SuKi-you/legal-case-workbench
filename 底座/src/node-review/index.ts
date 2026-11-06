import type { InformationEntity, NeedCoverage } from '../information/contracts.ts';
import type { LoopFinding, LoopRun, LoopSource } from '../loops/contracts.ts';
import { canonicalJson } from '../utils/canonical.ts';
import {
  nodePreparationSchema, nodeReviewKindSchema, nodeReviewSchema,
  type BuildNodeReviewInput, type NodePreparation, type NodeReview,
} from './contracts.ts';

export * from './contracts.ts';
export { nodeReviewLines } from './render.ts';

export class NodeReviewError extends Error {
  readonly code: 'NODE_REVIEW_RUN_INVALID' | 'NODE_REVIEW_CONTRIBUTION_INVALID';
  constructor(code: NodeReviewError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'NodeReviewError';
    this.code = code;
  }
}

const sourceKey = (source: LoopSource) => `${source.materialId}/${source.versionId}/${source.textSha256}`;
const sourceKeys = (sources: readonly LoopSource[]) => [...new Set(sources.map(sourceKey))].sort();
const normalize = (value: string | null) => value?.normalize('NFKC').replace(/\s+/gu, ' ').trim() ?? null;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const keys = <T>(a: Map<string, T>, b: Map<string, T>) => [...new Set([...a.keys(), ...b.keys()])];

function group<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const members = groups.get(id) ?? [];
    members.push(item);
    groups.set(id, members);
  }
  return groups;
}

function sourceChanges(baseline: LoopRun, current: LoopRun): NodeReview['sources'] {
  const old = group(baseline.sources, (source) => source.materialId);
  const next = group(current.sources, (source) => source.materialId);
  const byContent = group([...baseline.sources, ...current.sources], (source) => source.textSha256);
  return keys(old, next).flatMap((materialId) => {
    const before = old.get(materialId) ?? [];
    const after = next.get(materialId) ?? [];
    if (same(sourceKeys(before), sourceKeys(after))) return [];
    const beforeKeys = new Set(sourceKeys(before));
    const duplicates = after.filter((source) => !beforeKeys.has(sourceKey(source))).flatMap((source) =>
      (byContent.get(source.textSha256) ?? []).filter((candidate) => sourceKey(candidate) !== sourceKey(source)),
    );
    return [{ materialId, kind: before.length === 0 ? 'added' : after.length === 0 ? 'left_selection' : 'version_changed',
      before, after, duplicateContent: [...new Map(duplicates.map((source) => [sourceKey(source), source])).values()] }];
  });
}

function entityKey(entity: InformationEntity | null): unknown {
  if (!entity) return null;
  return entity.identity ? [entity.kind, normalize(entity.identity.scheme), normalize(entity.identity.value)]
    : [entity.kind, normalize(entity.name)];
}

/** Only exact normalized content with a safe source or explicit event anchor is compared across runs. */
function factKey(finding: LoopFinding, needScope: unknown): string {
  const record = finding.record;
  const spans = [...new Set(finding.citations.map(({ textSha256, start, end }) => `${textSha256}/${start}/${end}`))].sort();
  if (!record) return canonicalJson([finding.needId, needScope, normalize(finding.statement), spans]);
  const roles = [record.subject, record.object, record.attributedTo];
  const hasExplicitEvent = record.event.key !== null && roles.every((entity) => entity === null || entity.identity !== null);
  const time = record.time.start && record.time.end
    ? [record.time.precision, record.time.start, record.time.end]
    : [record.time.precision, normalize(record.time.raw)];
  return canonicalJson({
    needId: finding.needId, needScope, topic: normalize(record.topic), roles: roles.map(entityKey),
    event: [normalize(record.event.type), normalize(record.event.key)],
    time, period: normalize(record.period), basis: normalize(record.basis),
    value: [record.value.kind, normalize(record.value.normalized ?? record.value.raw), normalize(record.value.unit)],
    polarity: record.polarity,
    qualifiers: record.qualifiers,
    uncertainty: record.uncertainty.map(normalize).sort(),
    // With no structured value, descriptions may be the only distinction between two claims.
    description: record.value.normalized === null && record.value.raw === null ? normalize(record.event.description) : null,
    anchor: hasExplicitEvent ? null : spans,
  });
}

function findingKey(run: LoopRun): (finding: LoopFinding) => string {
  const scopes = new Map(run.needs.map((need) => {
    const spec = need.spec;
    return [need.id, spec ? [normalize(spec.topic), normalize(spec.subject), normalize(spec.object),
      normalize(spec.period), normalize(spec.basis), spec.applicable] : null] as const;
  }));
  return (finding) => factKey(finding, scopes.get(finding.needId) ?? null);
}

function evidence(finding: LoopFinding): NodeReview['facts'][number]['before'][number] {
  return { findingId: finding.id, needId: finding.needId, statement: finding.statement, citations: finding.citations,
    ...(finding.record ? { record: finding.record } : {}) };
}

function evidenceKeys(findings: readonly LoopFinding[], key: (finding: LoopFinding) => string): string[] {
  return [...new Set(findings.flatMap((finding) => finding.citations.map((citation) =>
    canonicalJson([key(finding), finding.record?.origin, sourceKey(citation), citation.start, citation.end, citation.quote]),
  )))].sort();
}

function factChanges(baseline: LoopRun, current: LoopRun): NodeReview['facts'] {
  const baselineKey = findingKey(baseline);
  const currentKey = findingKey(current);
  const old = group(baseline.findings, baselineKey);
  const next = group(current.findings, currentKey);
  return keys(old, next).flatMap((key) => {
    const before = old.get(key) ?? [];
    const after = next.get(key) ?? [];
    if (same(evidenceKeys(before, baselineKey), evidenceKeys(after, currentKey))) return [];
    const needId = (after[0] ?? before[0])!.needId;
    const currentNeed = current.information?.needs.find((item) => item.needId === needId);
    const kind = before.length === 0 ? 'new_record' : after.length === 0 ? 'not_carried_forward' : 'evidence_changed';
    let reason: string;
    if (kind === 'new_record') reason = '当前整理出现了基线中未匹配到的记录，保留原文供核对。';
    else if (kind === 'evidence_changed') reason = '匹配的记录仍在，引用的材料版本、位置或来源性质发生变化。';
    else reason = !currentNeed || currentNeed.unread.length > 0 || currentNeed.coverage === 'unread'
      ? '基线记录未在本次结果中匹配，当前覆盖仍有缺口，需继续核对。'
      : '基线记录未在本次结果中匹配，需核对选用来源、修订版本和提取差异。';
    return [{ kind, needId, reason, before: before.map(evidence), after: after.map(evidence) }];
  });
}

function coverageView(coverage: NeedCoverage | undefined): NodeReview['coverage'][number]['before'] {
  if (!coverage) return null;
  const { coverage: status, satisfaction, consistency, support, examined, unread, missingFields } = coverage;
  return { coverage: status, satisfaction, consistency, support,
    examined: [...examined].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b))),
    unread: [...unread].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b))),
    missingFields: [...missingFields].sort() };
}

function coverageChanges(baseline: LoopRun, current: LoopRun): NodeReview['coverage'] {
  const old = new Map(baseline.needs.map((need) => [need.id, need]));
  const next = new Map(current.needs.map((need) => [need.id, need]));
  const oldCoverage = new Map(baseline.information?.needs.map((item) => [item.needId, item]));
  const newCoverage = new Map(current.information?.needs.map((item) => [item.needId, item]));
  return keys(old, next).flatMap((needId) => {
    const before = coverageView(oldCoverage.get(needId));
    const after = coverageView(newCoverage.get(needId));
    const definitionChanged = !same(old.get(needId), next.get(needId));
    if (same(before, after) && !definitionChanged) return [];
    return [{ needId, question: (next.get(needId) ?? old.get(needId))!.question, definitionChanged, before, after }];
  });
}

const findingIndex = (run: LoopRun) => new Map(run.findings.map((finding) => [finding.id, finding]));
function findEvidence(findings: ReadonlyMap<string, LoopFinding>, findingIds: readonly string[]): LoopFinding[] {
  return findingIds.map((id) => {
    const found = findings.get(id);
    if (!found) throw new NodeReviewError('NODE_REVIEW_RUN_INVALID', '审查引用不在固定运行中。');
    return found;
  });
}

function conflictChanges(baseline: LoopRun, current: LoopRun): NodeReview['conflicts'] {
  const baselineKey = findingKey(baseline);
  const currentKey = findingKey(current);
  const describe = (run: LoopRun, keyOf: (finding: LoopFinding) => string) => {
    const index = findingIndex(run);
    return new Map((run.information?.conflicts ?? []).map((item) => {
      const findings = findEvidence(index, item.findingIds);
      const key = canonicalJson([item.field, findings.map(keyOf).sort()]);
      return [key, { item, findings }] as const;
    }));
  };
  const old = describe(baseline, baselineKey);
  const next = describe(current, currentKey);
  return keys(old, next).flatMap((key) => {
    const before = old.get(key);
    const after = next.get(key);
    if (before && after && before.item.classification === after.item.classification
      && same(evidenceKeys(before.findings, baselineKey), evidenceKeys(after.findings, currentKey))) return [];
    const view = (record: typeof before) => record ? { classification: record.item.classification,
      field: record.item.field, reason: record.item.reason, evidence: record.findings.map(evidence) } : null;
    return [{ kind: !before ? 'added' : !after ? 'not_carried_forward' : 'changed', before: view(before), after: view(after) }];
  });
}

function professionalChanges(baseline: LoopRun, current: LoopRun): NodeReview['professional'] {
  const old = new Map(baseline.professionalReview?.assessments.map((item) => [item.checkId, item]));
  const next = new Map(current.professionalReview?.assessments.map((item) => [item.checkId, item]));
  const baselineReviewer = baseline.professionalReview?.reviewer ?? null;
  const currentReviewer = current.professionalReview?.reviewer ?? null;
  const baselineIndex = findingIndex(baseline);
  const currentIndex = findingIndex(current);
  const baselineKey = findingKey(baseline);
  const currentKey = findingKey(current);
  const changes: NodeReview['professional']['changes'] = [];
  for (const checkId of keys(old, next)) {
    const before = old.get(checkId);
    const after = next.get(checkId);
    const oldEvidence = findEvidence(baselineIndex, before?.findingIds ?? []);
    const newEvidence = findEvidence(currentIndex, after?.findingIds ?? []);
    if (same(baselineReviewer, currentReviewer) && before?.state === after?.state
      && same(evidenceKeys(oldEvidence, baselineKey), evidenceKeys(newEvidence, currentKey))) continue;
    changes.push({ checkId,
      before: before ? { checkId, state: before.state, reason: before.reason, evidence: oldEvidence.map(evidence) } : null,
      after: after ? { checkId, state: after.state, reason: after.reason, evidence: newEvidence.map(evidence) } : null });
  }
  return { baselineReviewer, currentReviewer, baselineDecision: baseline.professionalReview?.decision ?? null,
    currentDecision: current.professionalReview?.decision ?? null, changes };
}

function scopeOf({ current, currentScope: scope, unreadMaterialIds, unparsedAttachmentIds }: BuildNodeReviewInput): NodeReview['scope'] {
  const actual = new Set(sourceKeys(current.sources));
  const expected = new Set(sourceKeys(scope ?? []));
  return { checked: scope !== undefined, missingSources: scope?.filter((source) => !actual.has(sourceKey(source))) ?? [],
    unexpectedSources: scope ? current.sources.filter((source) => !expected.has(sourceKey(source))) : [],
    ...(unreadMaterialIds?.length ? { unreadMaterialIds: [...new Set(unreadMaterialIds)] } : {}),
    ...(unparsedAttachmentIds?.length ? { unparsedAttachmentIds: [...new Set(unparsedAttachmentIds)] } : {}) };
}

type PreparationInput = Pick<NodePreparation, 'kind' | 'instruction' | 'reason'> &
  Partial<Pick<NodePreparation, 'needIds' | 'currentFindingIds' | 'baselineFindingIds' | 'sources'>>;
function preparations(input: BuildNodeReviewInput, review: NodeReview): NodePreparation[] {
  const { current } = input;
  const result: NodePreparation[] = [];
  const add = ({ kind, instruction, reason, needIds = [], currentFindingIds = [], baselineFindingIds = [], sources = [] }: PreparationInput) => {
    result.push({ id: `base.${result.length + 1}`, kind, instruction, reason, needIds, currentFindingIds, baselineFindingIds, sources });
  };
  if (!review.scope.checked || review.scope.missingSources.length || review.scope.unexpectedSources.length) {
    add({ kind: 'read', instruction: '确认当前案卷应审材料及固定版本，再整理遗漏或过时的来源。',
      reason: '当前选用的整理范围尚未与应审范围一致核对。', sources: review.scope.missingSources });
  }
  if (review.scope.unreadMaterialIds?.length || review.scope.unparsedAttachmentIds?.length) {
    add({ kind: 'read', instruction: '补齐尚无文字版本的材料，取得未解析附件的文字或由承办人核对原件。',
      reason: '案件仍含未进入文字整理的材料，当前结果只覆盖已经选读的文字。' });
  }
  const currentChecks = new Map(current.professionalReview?.assessments.map((item) => [item.checkId, item]));
  const currentCoverage = new Map(current.information?.needs.map((item) => [item.needId, item]));
  for (const action of current.professionalReview?.actions ?? []) {
    add({ kind: action.kind, instruction: action.instruction, reason: action.reason, needIds: [action.needId],
      currentFindingIds: currentChecks.get(action.checkId)?.findingIds ?? [], sources: action.sources ?? [] });
  }
  for (const need of current.needs) {
    const coverage = currentCoverage.get(need.id);
    if (coverage?.satisfaction === 'not_applicable' || need.spec?.applicable === false) continue;
    if (!coverage || coverage.unread.length || coverage.coverage === 'unread') {
      if (!result.some((item) => item.kind === 'read' && item.needIds.includes(need.id))) {
        add({ kind: 'read', needIds: [need.id], instruction: `补读「${need.question}」所需材料。`,
          reason: '本次有未读或无覆盖台账的来源，需补齐查阅。', sources: coverage?.unread ?? current.sources });
      }
    } else if (coverage.satisfaction !== 'satisfied' || coverage.consistency !== 'consistent') {
      if (!result.some((item) => item.needIds.includes(need.id))) {
        const action = coverage.nextActions.find((candidate) => candidate.kind !== 'read');
        add({ kind: action?.kind === 'clarify' ? 'clarify' : 'human_review', needIds: [need.id],
          instruction: action?.instruction ?? `核对「${need.question}」及其材料支持。`,
          reason: action?.reason ?? coverage.reason, currentFindingIds: coverage.findingIds });
      }
    }
  }
  const activeConflicts = current.information?.conflicts.filter((item) =>
    item.classification === 'inconsistent' || item.classification === 'possible_conflict') ?? [];
  if (activeConflicts.length) {
    add({ kind: 'human_review', instruction: '并列核对当前相反或可能相反的记载，确认对应主体、事项、时间与口径。',
      reason: '当前运行仍有冲突或疑似冲突。', currentFindingIds: [...new Set(activeConflicts.flatMap((item) => item.findingIds))] });
  }
  const previousConflicts = review.conflicts.filter((item) => item.kind === 'not_carried_forward');
  if (previousConflicts.length) {
    add({ kind: 'human_review', instruction: '复看基线曾列出的冲突及原文，核对材料范围变化与差异。',
      reason: '基线冲突未在当前结果中匹配，消失原因仍待核对。',
      baselineFindingIds: [...new Set(previousConflicts.flatMap((item) => item.before?.evidence.map((e) => e.findingId) ?? []))] });
  }
  const omittedFacts = review.facts.filter((item) => item.kind === 'not_carried_forward');
  if (omittedFacts.length) {
    add({ kind: 'human_review', instruction: '复查当前结果中未匹配的基线记录，逐条核对引文及材料变更。',
      reason: '旧记录未出现在当前整理结果中，需核对选择范围、版本修订及提取差异。',
      baselineFindingIds: [...new Set(omittedFacts.flatMap((item) => item.before.map((e) => e.findingId)))] });
  }
  if (!same(review.professional.baselineReviewer, review.professional.currentReviewer)) {
    add({ kind: 'human_review', instruction: '对照两次专业规则的版本和适用范围。',
      reason: '专业复核器身份或版本发生变化，专业状态差异需区分规则变化与材料变化。' });
  }
  const nodeStep = {
    opponent_response: ['逐条对照对方答辩、既有陈述和相应出处，列出拟回应及待核事项。', '为答辩后的争点和应对准备建立清单。'],
    new_evidence: ['核对新增材料原件、固定版本及取得经过，将同文副本与不同证据分开。', '为新增材料准备来源和影响核对。'],
    hearing_preparation: ['整理可核对的材料索引、时间线、争点及待补证事项，确认庭前需准备的原件。', '由承办人据此复核庭前准备。'],
  }[input.kind];
  add({ kind: 'prepare', instruction: nodeStep[0]!, reason: nodeStep[1]! });
  return result;
}

function contribution(input: BuildNodeReviewInput, review: NodeReview): NodePreparation[] {
  if (!input.contribute) return [];
  // A plugin receives a detached snapshot and can only append bounded, validated tasks.
  const raw = input.contribute(structuredClone({ kind: input.kind, baseline: input.baseline, current: input.current, review }));
  const currentIds = new Set(input.current.findings.map((item) => item.id));
  const baselineIds = new Set(input.baseline.findings.map((item) => item.id));
  const needIds = new Set(input.current.needs.map((item) => item.id));
  const sources = new Set(sourceKeys(input.current.sources));
  const ids = new Set(review.preparations.map((item) => item.id));
  const parsed = nodePreparationSchema.array().max(100).safeParse(raw);
  if (!parsed.success) throw new NodeReviewError('NODE_REVIEW_CONTRIBUTION_INVALID', '专业插件准备事项不符合约定。');
  for (const item of parsed.data) {
    if (ids.has(item.id) || item.instruction.length > 4000 || item.reason.length > 4000
      || [item.needIds, item.currentFindingIds, item.baselineFindingIds, item.sources].some((items) => items.length > 100)
      || item.needIds.some((id) => !needIds.has(id))
      || item.currentFindingIds.some((id) => !currentIds.has(id))
      || item.baselineFindingIds.some((id) => !baselineIds.has(id))
      || item.sources.some((source) => !sources.has(sourceKey(source)))) {
      throw new NodeReviewError('NODE_REVIEW_CONTRIBUTION_INVALID', '专业插件准备事项的标识或出处超出审查范围。');
    }
    ids.add(item.id);
  }
  return parsed.data;
}

/** Build a comparison of committed, source-validated runs read from the same case view. */
export function buildNodeReview(input: BuildNodeReviewInput): NodeReview {
  const { baseline, current } = input;
  const kind = nodeReviewKindSchema.parse(input.kind);
  if (baseline.caseId !== current.caseId || (baseline.id === current.id && (kind !== 'hearing_preparation' || !same(baseline, current)))
    || (baseline.id !== current.id && (baseline.baseCaseRevision >= current.baseCaseRevision
      || Date.parse(baseline.finishedAt) > Date.parse(current.createdAt)))) {
    throw new NodeReviewError('NODE_REVIEW_RUN_INVALID', '审查需要同案有效的基线与当前运行；庭前准备可直接复用同一运行。');
  }
  const review: NodeReview = {
    version: 1, caseId: current.caseId, kind, baselineRunId: baseline.id, currentRunId: current.id,
    status: 'requires_review', scope: scopeOf(input),
    sources: sourceChanges(baseline, current), facts: factChanges(baseline, current), coverage: coverageChanges(baseline, current),
    conflicts: conflictChanges(baseline, current), professional: professionalChanges(baseline, current), preparations: [],
  };
  review.preparations = preparations(input, review);
  review.preparations.push(...contribution(input, review));
  const professionalPending = current.professionalReview && (
    current.professionalReview.decision !== 'ready' || current.professionalReview.assessments.some((item) =>
      item.state === 'unresolved' || item.state === 'conflicting'));
  if (current.status === 'completed' && !professionalPending && review.preparations.every((item) => item.kind === 'prepare')) {
    review.status = 'ready_for_review';
  }
  return nodeReviewSchema.parse(review);
}
