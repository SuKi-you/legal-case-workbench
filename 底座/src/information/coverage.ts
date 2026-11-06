import {
  informationConflictSchema, informationFindingSchema, informationSourceSchema, needCoverageSchema, structuredNeedSchema,
  type InformationAttempt, type InformationConflict, type InformationEntity, type InformationFinding,
  type InformationRecord, type InformationSource, type NeedCoverage, type NeedSpec, type StructuredNeed,
} from './contracts.ts';

type Field = NeedSpec['requiredFields'][number];
type ScopedFinding = InformationFinding & { record: InformationRecord };
const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const sourceKey = (source: InformationSource) => `${source.materialId}/${source.versionId}/${source.textSha256}`;
const known = (value: string | null | undefined): value is string => (
  value !== undefined && value !== null && value.trim().length > 0
  && !/^(?:未知|不详|不明|未明确|unknown|unclear|n\/?a|\?+)$/iu.test(value.trim())
);
const fieldLabels: Record<string, string> = {
  subject: '主体', object: '对象', attributedTo: '陈述归属', 'event.key': '事件标识',
  time: '明确时间', value: '具体内容或数值', period: '所属期间', basis: '比较口径',
  document_support: '对应事项的支持材料', structured_record: '可核对的结构化记录',
  information: '与该需求对应的信息', spec: '专业需求的匹配条件',
};

function identity(entity: InformationEntity | null): string | null {
  return entity?.identity ? `${normalized(entity.identity.scheme)}:${normalized(entity.identity.value)}` : null;
}
function entityMatch(selector: string, entity: InformationEntity | null): 'match' | 'unknown' | 'different' {
  if (!entity || !known(entity.name)) return 'unknown';
  const wanted = normalized(selector);
  return wanted === normalized(entity.name)
    || (entity.identity && (wanted === normalized(entity.identity.value) || wanted === identity(entity)))
    ? 'match' : 'different';
}
function unresolvedField(record: InformationRecord, field: 'time' | 'period'): boolean {
  const dimensions = field === 'time' ? /时间|日期|年份|年度|time|date|year/iu : /期间|时期|月份|年份|年度|period|month|year/iu;
  return record.uncertainty.some((item) => dimensions.test(item));
}
function explicitPeriod(record: InformationRecord): boolean {
  if (!known(record.period) || unresolvedField(record, 'period')) return false;
  // A month without its year and unanchored relative periods remain unresolved.
  return !/^(?:\d{1,2}|[一二三四五六七八九十]+)月(?:份)?$/u.test(record.period)
    && !/^(?:(?:上|下|本|这|近|去|前)(?:个)?(?:月|周|年)|last\s+(?:week|month|year)|this\s+(?:week|month|year))$/iu.test(record.period);
}
function scopeMatch(record: InformationRecord, spec: NeedSpec): { different: boolean; missing: Field[] } {
  if (record.topic !== spec.topic) return { different: true, missing: [] };
  const missing: Field[] = [];
  for (const field of ['subject', 'object'] as const) {
    if (spec[field] === null) continue;
    const match = entityMatch(spec[field], record[field]);
    if (match === 'different') return { different: true, missing: [] };
    if (match === 'unknown') missing.push(field);
  }
  for (const field of ['period', 'basis'] as const) {
    if (spec[field] === null) continue;
    if (!known(record[field]) || (field === 'period' && !explicitPeriod(record))) missing.push(field);
    else if (normalized(record[field]) !== normalized(spec[field])) return { different: true, missing: [] };
  }
  return { different: false, missing };
}
function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = match[3] === undefined ? 1 : Number(match[3]);
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0); parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
function explicitTime(record: InformationRecord): boolean {
  const { time } = record;
  if (unresolvedField(record, 'time')) return false;
  if (!['date', 'month', 'range'].includes(time.precision) || !time.start || !validDate(time.start)) return false;
  if (time.precision === 'range' && (!time.end || !validDate(time.end))) return false;
  return time.end === null || (validDate(time.end) && time.start <= time.end);
}
function valuePresent(record: InformationRecord): boolean {
  const { value } = record;
  if (value.kind === 'unknown' || !known(value.normalized)) return false;
  if (value.kind === 'money' || value.kind === 'number') return /^-?\d+(?:\.\d+)?$/u.test(value.normalized);
  if (value.kind === 'boolean') return value.normalized === 'true' || value.normalized === 'false';
  if (value.kind === 'date') return validDate(value.normalized);
  return true;
}
function hasField(record: InformationRecord, field: Field): boolean {
  if (field === 'subject' || field === 'object' || field === 'attributedTo') return known(record[field]?.name);
  if (field === 'event.key') return known(record.event.key);
  if (field === 'time') return explicitTime(record);
  if (field === 'value') return valuePresent(record)
    && !(record.polarity === 'denied' && ['money', 'number', 'date'].includes(record.value.kind));
  if (field === 'period') return explicitPeriod(record);
  return known(record[field]);
}
function compatible(left: InformationRecord, right: InformationRecord): boolean {
  if (left.topic !== right.topic || left.event.type !== right.event.type || !known(left.event.key)
    || left.event.key !== right.event.key || identity(left.subject) === null || identity(left.subject) !== identity(right.subject)
    || left.period !== right.period || left.basis !== right.basis || left.polarity !== right.polarity) return false;
  const qualifierKey = (record: InformationRecord) => JSON.stringify(Object.entries(record.qualifiers).sort(([a], [b]) => a.localeCompare(b)));
  if (qualifierKey(left) !== qualifierKey(right)) return false;
  if (left.object && right.object) {
    const a = identity(left.object), b = identity(right.object);
    if (a !== null && b !== null ? a !== b : normalized(left.object.name) !== normalized(right.object.name)) return false;
  }
  if (explicitTime(left) && explicitTime(right)
    && (left.time.start !== right.time.start || left.time.end !== right.time.end)) return false;
  if (valuePresent(left) && valuePresent(right)
    && (left.value.kind !== right.value.kind || left.value.unit !== right.value.unit || left.value.normalized !== right.value.normalized)) return false;
  return true;
}

/** Combine only explicitly identified compatible events; no cross-event field filling. */
function eventGroups(findings: ScopedFinding[]): ScopedFinding[][] {
  const groups: ScopedFinding[][] = findings.map((finding) => [finding]);
  const buckets = new Map<string, ScopedFinding[][]>();
  for (const finding of findings) {
    const record = finding.record;
    const actor = identity(record.subject);
    if (actor === null || !known(record.event.key)) continue;
    const key = JSON.stringify([record.topic, actor, record.event.type, record.event.key, record.period, record.basis, record.polarity]);
    const bucket = buckets.get(key) ?? [];
    // Complete-link grouping prevents an unknown field from bridging two incompatible versions.
    const group = bucket.find((items) => items.every((item) => compatible(item.record, record)));
    if (group) group.push(finding); else bucket.push([finding]);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) for (const group of bucket) if (group.length > 1) groups.push(group);
  return groups;
}
function ambiguousIdentity(findings: ScopedFinding[], spec: NeedSpec): boolean {
  for (const role of ['subject', 'object'] as const) {
    if (spec[role] === null) continue;
    const identities = new Set<string>();
    for (const finding of findings) {
      const entity = finding.record[role];
      if (entity && normalized(entity.name) === normalized(spec[role])) {
        const value = identity(entity);
        if (value) identities.add(value);
      }
    }
    if (identities.size > 1) return true;
  }
  return false;
}
function supportOf(findings: ScopedFinding[]): NeedCoverage['support'] {
  if (findings.some((finding) => finding.record.origin === 'document_record')) return 'document_supported';
  if (findings.some((finding) => finding.record.origin === 'party_statement')) return 'statement_only';
  return findings.length > 0 ? 'inference_only' : 'none';
}
function bestMissing(groups: ScopedFinding[][], fields: Field[], origin?: 'document_record'): string[] {
  if (groups.length === 0) return [...fields];
  return groups.map((group) => fields.filter((field) => !group.some((finding) => (
    finding.record.origin !== 'inference' && (origin === undefined || finding.record.origin === origin) && hasField(finding.record, field)
  )))).sort((left, right) => left.length - right.length)[0]!;
}

/**
 * Checks declared information coverage, never legal truth. Read coverage is
 * tracked per need; an already obtained source-backed record may answer another
 * need without pretending that all its materials have been searched again.
 */
export function evaluateInformationNeeds(input: {
  needs: readonly StructuredNeed[]; findings: readonly InformationFinding[]; sources: readonly InformationSource[];
  attempts: readonly InformationAttempt[]; conflicts: readonly InformationConflict[];
}): NeedCoverage[] {
  const needs = input.needs.map((need) => structuredNeedSchema.parse(need));
  const findings = input.findings.map((finding) => informationFindingSchema.parse(finding));
  const sources = input.sources.map((source) => informationSourceSchema.parse(source));
  const conflicts = input.conflicts.map((conflict) => informationConflictSchema.parse(conflict));
  if (new Set(needs.map((need) => need.id)).size !== needs.length || new Set(findings.map((finding) => finding.id)).size !== findings.length
    || new Set(sources.map((source) => `${source.materialId}/${source.versionId}`)).size !== sources.length) throw new Error('INFORMATION_NEED_INVALID: Need, finding and source identities must be unique.');
  const selected = new Set(sources.map(sourceKey));
  const backed = findings.filter((finding) => input.attempts.some((attempt) => {
    if (!attempt.findingIds.includes(finding.id)) return false;
    const observed = new Set(attempt.examined.filter((source) => selected.has(sourceKey(source))).map(sourceKey));
    return finding.citations.every((citation) => selected.has(sourceKey(citation)) && observed.has(sourceKey(citation)));
  }));

  return needs.map((need): NeedCoverage => {
    const examinedKeys = new Set(input.attempts.filter((attempt) => attempt.request.needId === need.id)
      .flatMap((attempt) => attempt.examined.filter((source) => selected.has(sourceKey(source))).map(sourceKey)));
    const examined = sources.filter((source) => examinedKeys.has(sourceKey(source)));
    const unread = sources.filter((source) => !examinedKeys.has(sourceKey(source)));
    const rejected = new Set(input.attempts.filter((attempt) => attempt.request.needId === need.id)
      .flatMap((attempt) => (attempt.readIssues ?? []).map((issue) => sourceKey(issue.source))));
    const rejectedCount = unread.filter((source) => rejected.has(sourceKey(source))).length;
    const scopeUnknown = new Set<string>();
    const relevant = backed.filter((finding) => {
      if (!need.spec) return finding.needId === need.id;
      if (!finding.record) return finding.needId === need.id;
      const match = scopeMatch(finding.record, need.spec);
      if (match.different) return false;
      for (const field of match.missing) scopeUnknown.add(field);
      return true;
    });
    const structured = relevant.filter((finding): finding is ScopedFinding => finding.record !== undefined);
    const exact = need.spec ? structured.filter((finding) => scopeMatch(finding.record, need.spec!).missing.length === 0) : [];
    const relevantIds = new Set(relevant.map((finding) => finding.id));
    const affecting = conflicts.filter((conflict) => conflict.classification !== 'different_scope'
      && conflict.findingIds.every((id) => relevantIds.has(id)));
    const hasConflict = affecting.some((conflict) => conflict.classification === 'inconsistent');
    const identityUnclear = need.spec !== undefined && ambiguousIdentity(structured, need.spec);
    const contextUnclear = identityUnclear || affecting.length > 0 || structured.some((finding) => finding.record.polarity === 'uncertain');
    const requiredFields = need.spec?.requiredFields ?? [];
    const groups = eventGroups(exact);
    // Unknown scope does not erase information already supplied in that record.
    const missing = bestMissing(groups.length > 0 ? groups : eventGroups(structured), requiredFields);
    if (exact.length === 0) for (const field of scopeUnknown) if (!missing.includes(field)) missing.push(field);
    const hasLegacy = relevant.some((finding) => finding.record === undefined);
    const full = groups.some((group) => group.some((finding) => finding.record.origin !== 'inference')
      && requiredFields.every((field) => group.some((finding) => finding.record.origin !== 'inference' && hasField(finding.record, field))));
    const documented = groups.some((group) => group.some((finding) => finding.record.origin === 'document_record')
      && requiredFields.every((field) => group.some((finding) => finding.record.origin === 'document_record' && hasField(finding.record, field))));
    const support = supportOf(structured);
    let coverage: NeedCoverage['coverage'] = relevant.length > 0 ? (full ? 'found' : 'partial')
      : (unread.length > 0 || examined.length === 0 ? 'unread' : 'not_found_in_examined');
    let consistency: NeedCoverage['consistency'] = hasConflict ? 'conflicting'
      : contextUnclear || scopeUnknown.size > 0 || hasLegacy || !need.spec ? 'ambiguous' : 'consistent';
    let satisfaction: NeedCoverage['satisfaction'];
    let reason: string;
    const missingFields = [...missing];
    if (need.spec?.applicable === false) {
      satisfaction = 'not_applicable'; consistency = 'consistent';
      reason = '专业插件明确声明此需求不适用；保留读取范围，不据此提出补充问题。';
      missingFields.length = 0;
    } else if (!need.spec) {
      satisfaction = 'needs_review'; reason = '缺少专业需求的匹配与满足条件，已有记录不能仅凭需求 ID 被认定为满足。';
      missingFields.push('spec');
    } else if (hasConflict || contextUnclear) {
      satisfaction = 'needs_review';
      reason = hasConflict ? '对应事项存在相互不一致的记载，应核对双方出处，保留已有陈述。'
        : identityUnclear ? '同一姓名对应多个明确身份，需先确认需求指向的主体，避免将不同人的记录混在一起。'
          : '对应事项仍有比较条件或陈述含义待核对，保留已有内容并交专业复核。';
    } else if (full && (need.spec.minimumSupport === 'statement' || documented)) {
      satisfaction = 'satisfied';
      reason = '已找到符合本次声明条件且带出处的记录；读取范围与支持类型另列，不代表法律事实已被证实。';
    } else if (hasLegacy && structured.length === 0) {
      satisfaction = 'needs_review'; reason = '已有文字记录，但尚无可按专业条件核对的结构化字段；应核对原文并整理记录。';
      missingFields.push('structured_record');
    } else if (support === 'inference_only') {
      satisfaction = 'needs_review'; reason = '目前仅有推断记录，不能替代材料记载或当事人陈述，应先核对原文。';
    } else {
      satisfaction = 'needs_information';
      if (full && need.spec.minimumSupport === 'document' && !documented) {
        missingFields.push('document_support');
        reason = '已有相关陈述，但本次需求要求对应事项的支持材料；保留原陈述，仅补查印证材料。';
      } else if (relevant.length === 0) {
        missingFields.push('information');
        reason = unread.length > 0 ? '已检查范围尚未找到对应记录，仍有选定材料未读取，先补查这些材料。'
          : '本次选定且已读取的材料范围内未找到对应信息；这不等于案件中不存在该信息。';
      } else if (requiredFields.includes('value') && exact.some((finding) => finding.record.polarity === 'denied'
        && ['money', 'number', 'date'].includes(finding.record.value.kind))) {
        reason = '已提供排除性说法，但确切值尚未明确；保留该说法，仅补充确切值。';
      } else {
        reason = '已找到相关内容，但所需字段尚未在同一可对应事件的记录中补齐，保留现有记录并只补查缺项。';
      }
    }
    if (satisfaction === 'not_applicable') coverage = relevant.length > 0 ? coverage : (examined.length === sources.length && examined.length > 0 ? 'not_found_in_examined' : 'unread');
    const nextActions: NeedCoverage['nextActions'] = [];
    if (rejectedCount > 0 && satisfaction !== 'not_applicable') {
      reason += ` 其中 ${rejectedCount} 个来源的模型结果未通过校验，仍属未核对范围。`;
      nextActions.push({ kind: 'review', needId: need.id,
        reason: '模型结果未通过校验，保留本需求下其他来源的可核对结果。',
        instruction: `人工核对“${need.question}”在校验未通过来源中的原文。` });
    }
    if (satisfaction !== 'satisfied' && satisfaction !== 'not_applicable' && (rejectedCount === 0 || unread.length > rejectedCount)) {
      const labels = [...new Set(missingFields)].map((field) => fieldLabels[field] ?? field).join('、');
      if (unread.length > rejectedCount && need.spec) {
        nextActions.push({ kind: 'read', needId: need.id,
          reason: `仍有 ${unread.length - rejectedCount} 个选定文字版本可以继续读取，先补查材料，沿用已有记录。`,
          instruction: `围绕“${need.question}”检查尚未读取的选定材料${labels ? `，重点寻找：${labels}` : '，重点核对现有记录的差异'}。保留已提供的陈述及出处。` });
      } else if (satisfaction === 'needs_review') {
        nextActions.push({ kind: 'review', needId: need.id, reason,
          instruction: `核对“${need.question}”的${labels || '现有记录与相关出处'}，明确尚待核对的条件，沿用已提供内容。` });
      } else {
        nextActions.push({ kind: 'clarify', needId: need.id, reason,
          instruction: missingFields.includes('document_support')
            ? `已有“${need.question}”的相关陈述，请补充该事项的支持材料或说明可取得的材料线索。`
            : `关于“${need.question}”，当前仅需补充：${labels || '尚未明确的必要信息'}。已提供的内容保留。` });
      }
    }
    return needCoverageSchema.parse({
      needId: need.id, findingIds: relevant.map((finding) => finding.id), conflictIds: affecting.map((conflict) => conflict.id),
      coverage, consistency, support, satisfaction, missingFields: [...new Set(missingFields)], examined, unread, reason, nextActions,
    });
  });
}
