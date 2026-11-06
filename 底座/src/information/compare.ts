import { createHash } from 'node:crypto';
import {
  entityBindingSchema, informationFindingSchema,
  type EntityBinding, type InformationAnalysis, type InformationCompareOptions,
  type InformationConflict, type InformationEntity, type InformationFinding,
  type InformationRecord, type InformationRelation,
} from './contracts.ts';

type Result = Pick<InformationAnalysis, 'entities' | 'relations' | 'conflicts'>;
type EntityMatch = 'same' | 'possible' | 'different' | 'unknown' | 'absent';
type Mention = { findingId: string; role: 'subject' | 'object' | 'attributedTo'; entity: InformationEntity };
const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
const identifier = (entity: InformationEntity) => entity.identity
  ? `${normalized(entity.identity.scheme)}\n${normalized(entity.identity.value)}` : undefined;
const identityScheme = (entity: InformationEntity) => entity.identity && normalized(entity.identity.scheme);
const id = (prefix: string, values: unknown) => `${prefix}-${createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24)}`;
const sortedIds = (values: readonly string[]) => [...new Set(values)].sort();

export class InformationComparisonError extends Error {
  readonly code = 'INFORMATION_COMPARISON_INVALID';
  constructor(message: string) { super(`INFORMATION_COMPARISON_INVALID: ${message}`); this.name = 'InformationComparisonError'; }
}

function aliasMap(bindings: readonly EntityBinding[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const input of bindings) {
    const binding = entityBindingSchema.parse(input);
    const canonical = normalized(binding.canonical);
    for (const raw of [...binding.names, binding.canonical]) {
      const name = normalized(raw);
      if (result.has(name) && result.get(name) !== canonical) {
        throw new InformationComparisonError('A name occurs in incompatible explicit entity bindings.');
      }
      result.set(name, canonical);
    }
  }
  return result;
}

function entityMatch(a: InformationEntity | null, b: InformationEntity | null, aliases: Map<string, string>): EntityMatch {
  if (!a && !b) return 'absent';
  if (!a || !b) return 'unknown';
  if (a.kind !== b.kind && a.kind !== 'unknown' && b.kind !== 'unknown') return 'different';
  if (a.identity && b.identity && identityScheme(a) === identityScheme(b) && identifier(a) !== identifier(b)) return 'different';
  if (identifier(a) && identifier(a) === identifier(b)) return 'same';
  const leftAlias = aliases.get(normalized(a.name)), rightAlias = aliases.get(normalized(b.name));
  if (leftAlias && leftAlias === rightAlias) return 'same';
  return normalized(a.name) === normalized(b.name) ? 'possible' : 'unknown';
}

/** Canonical decimal strings; no floating-point arithmetic changes the comparison. */
function decimal(value: string | null): string | undefined {
  if (value === null || !/^[+-]?\d+(?:\.\d+)?$/u.test(value)) return undefined;
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/u, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const integer = whole.replace(/^0+(?=\d)/u, ''), tail = fraction.replace(/0+$/u, '');
  return `${negative && !(integer === '0' && tail === '') ? '-' : ''}${integer}${tail ? `.${tail}` : ''}`;
}

function date(value: string | null): string | undefined {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

function timeKey(record: InformationRecord): string | undefined {
  if (record.time.precision === 'relative' || record.time.precision === 'unknown') return undefined;
  const start = date(record.time.start), end = date(record.time.end);
  if (!start || !end || end < start) return undefined;
  return `${start}/${end}`;
}

function qualifiers(record: InformationRecord): string {
  return JSON.stringify(Object.entries(record.qualifiers).map(([key, value]) => [normalized(key), normalized(value)]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
}

function conflictingQualifiers(left: InformationRecord, right: InformationRecord): boolean {
  const rightValues = new Map(Object.entries(right.qualifiers).map(([key, value]) => [normalized(key), normalized(value)]));
  return Object.entries(left.qualifiers).some(([key, value]) => {
    const other = rightValues.get(normalized(key));
    return other !== undefined && normalized(value) !== other;
  });
}

function effectiveBoolean(record: InformationRecord): boolean | undefined {
  // normalized already describes the truth of the positive topic. A denied
  // statement with normalized=false must not be negated a second time.
  if (record.value.kind === 'boolean') {
    if (record.value.normalized === 'true') return true;
    if (record.value.normalized === 'false') return false;
    if (record.value.normalized !== null) return undefined;
  }
  if (record.value.kind === 'boolean') {
    if (record.polarity === 'affirmed') return true;
    if (record.polarity === 'denied') return false;
  }
  return undefined;
}

function valueKey(record: InformationRecord): string | undefined {
  const value = record.value;
  if (value.kind === 'money' || value.kind === 'number') {
    const amount = decimal(value.normalized);
    return amount === undefined ? undefined : `${value.kind}:${amount}`;
  }
  const boolean = effectiveBoolean(record);
  if (boolean !== undefined) return `boolean:${boolean}`;
  if (value.kind === 'date') {
    const parsed = date(value.normalized);
    return parsed === undefined ? undefined : `date:${parsed}`;
  }
  return value.kind === 'text' && value.normalized ? `text:${normalized(value.normalized)}` : undefined;
}

function sameMaterialDifferentVersions(a: InformationFinding, b: InformationFinding): boolean {
  return a.citations.some((left) => b.citations.some((right) => left.materialId === right.materialId
    && (left.versionId !== right.versionId || left.textSha256 !== right.textSha256)));
}

function sharesContent(a: InformationFinding, b: InformationFinding): boolean {
  return a.citations.some((left) => b.citations.some((right) => left.textSha256 === right.textSha256));
}

function entityGroups(findings: InformationFinding[], aliases: Map<string, string>): Result['entities'] {
  const mentions: Mention[] = [];
  for (const finding of findings) for (const role of ['subject', 'object', 'attributedTo'] as const) {
    const entity = finding.record?.[role];
    if (entity) mentions.push({ findingId: finding.id, role, entity });
  }
  const parents = mentions.map((_, index) => index);
  const root = (index: number): number => {
    let node = index;
    while (parents[node] !== node) node = parents[node]!;
    while (parents[index] !== index) { const next = parents[index]!; parents[index] = node; index = next; }
    return node;
  };
  const members = (index: number) => mentions.filter((_, candidate) => root(candidate) === root(index));
  for (let i = 0; i < mentions.length; i += 1) for (let j = i + 1; j < mentions.length; j += 1) {
    if (root(i) === root(j) || entityMatch(mentions[i]!.entity, mentions[j]!.entity, aliases) !== 'same') continue;
    // An unlabelled alias cannot bridge two conflicting strong identities.
    const left = members(i), right = members(j);
    if (left.some((a) => right.some((b) => entityMatch(a.entity, b.entity, aliases) === 'different'))) continue;
    parents[root(j)] = root(i);
  }
  const groups = new Map<number, Mention[]>();
  for (let i = 0; i < mentions.length; i += 1) groups.set(root(i), [...(groups.get(root(i)) ?? []), mentions[i]!]);
  return [...groups.values()].map((group) => ({
    id: id('entity', group.map((mention) => [mention.findingId, mention.role, mention.entity.name]).sort()),
    names: sortedIds(group.map((mention) => mention.entity.name)),
    kind: group.find((mention) => mention.entity.kind !== 'unknown')?.entity.kind ?? 'unknown' as const,
    findingIds: sortedIds(group.map((mention) => mention.findingId)),
  })).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Relates statements and detects inconsistencies in comparable structured
 * claims. Confirmation describes their recorded relationship, never truth or
 * evidence independence. Names alone never establish personal identity.
 */
export function compareInformation(
  input: readonly InformationFinding[], options: InformationCompareOptions = {},
): Result {
  const findings = input.map((finding) => informationFindingSchema.parse(finding)).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) throw new InformationComparisonError('Finding IDs must be unique.');
  const aliases = aliasMap(options.bindings ?? []);
  const boundIdentities = new Map<string, Set<string>>();
  for (const finding of findings) for (const role of ['subject', 'object', 'attributedTo'] as const) {
    const entity = finding.record?.[role];
    const canonical = entity && aliases.get(normalized(entity.name));
    if (!canonical || !entity?.identity) continue;
    const key = `${canonical}\n${identityScheme(entity)}`;
    const values = boundIdentities.get(key) ?? new Set<string>();
    values.add(normalized(entity.identity.value)); boundIdentities.set(key, values);
    if (values.size > 1) throw new InformationComparisonError('Explicit entity binding contradicts different identity values in the same scheme.');
  }
  const entities = entityGroups(findings, aliases);
  const relationMap = new Map<string, InformationRelation>();
  const conflictMap = new Map<string, InformationConflict>();
  const relation = (kind: InformationRelation['kind'], pair: readonly string[], status: InformationRelation['status'], reason: string) => {
    const findingIds = sortedIds(pair);
    if (findingIds.length < 2) return;
    const key = id('relation', [kind, findingIds]);
    const existing = relationMap.get(key);
    if (!existing || existing.status !== 'confirmed') relationMap.set(key, { id: key, kind, findingIds, status, reason });
  };
  const conflict = (pair: readonly string[], field: string, classification: InformationConflict['classification'], reason: string) => {
    const findingIds = sortedIds(pair);
    const key = id('conflict', [findingIds, field, classification]);
    conflictMap.set(key, { id: key, findingIds, field, classification, reason });
  };
  for (const group of entities) if (group.findingIds.length > 1) relation('same_entity', group.findingIds, 'confirmed',
    '这些提及具有相同明确身份标识，或已由显式人工别名绑定确认；各来源继续保留。');

  for (let i = 0; i < findings.length; i += 1) for (let j = i + 1; j < findings.length; j += 1) {
    const a = findings[i]!, b = findings[j]!, left = a.record, right = b.record;
    const pair = [a.id, b.id];
    if (sharesContent(a, b)) relation('same_source_content', pair, 'confirmed',
      '引用来源的文字哈希一致，属于相同文字内容；保留全部来源，不能据此认定为独立佐证。');
    if (!left || !right) continue;
    const subject = entityMatch(left.subject, right.subject, aliases);
    const object = entityMatch(left.object, right.object, aliases);
    for (const role of ['subject', 'object', 'attributedTo'] as const) {
      if (entityMatch(left[role], right[role], aliases) === 'possible') relation('possible_same_entity', pair, 'suggested',
        `两条记录的${role}名称相同，但缺少足以确认同一身份的标识或人工绑定，待核对。`);
    }
    const sameType = normalized(left.event.type) === normalized(right.event.type);
    const sameKey = sameType && left.event.key !== null && right.event.key !== null && normalized(left.event.key) === normalized(right.event.key);
    const strongSubject = subject === 'same' || (subject === 'absent' && sameKey);
    const strongObject = object === 'same' || object === 'absent';
    const leftTime = timeKey(left), rightTime = timeKey(right);
    const samePeriod = left.period !== null && right.period !== null && normalized(left.period) === normalized(right.period);
    const sameTime = leftTime !== undefined && leftTime === rightTime;
    const compatibleBasis = left.basis === right.basis || (left.basis !== null && right.basis !== null && normalized(left.basis) === normalized(right.basis));
    const compatiblePeriod = left.period === right.period || samePeriod;
    const compatibleQualifiers = qualifiers(left) === qualifiers(right);
    const potentialSubject = subject !== 'different' && object !== 'different';
    if (sameKey && potentialSubject && compatibleBasis && compatiblePeriod && compatibleQualifiers) {
      relation(strongSubject && strongObject ? 'same_event' : 'possible_same_event', pair,
        strongSubject && strongObject ? 'confirmed' : 'suggested',
        strongSubject && strongObject ? '事件类型、明确事件标识及参与主体一致，关联到同一事件；不同记载仍分别保留。'
          : '事件标识一致，但参与主体尚未充分对应，保留为同一事件候选。');
    } else if (sameType && strongSubject && strongObject && (samePeriod || sameTime) && compatibleBasis && compatibleQualifiers) {
      relation('possible_same_event', pair, 'suggested', '主体、事件类型及期间或时间相符，但缺少明确事件标识，需进一步核对是否同一事件。');
    }
    if (normalized(left.topic) !== normalized(right.topic)) continue;
    const aValue = valueKey(left), bValue = valueKey(right);
    const comparableValueKinds = left.value.kind === right.value.kind || (effectiveBoolean(left) !== undefined && effectiveBoolean(right) !== undefined);
    const aTruth = effectiveBoolean(left), bTruth = effectiveBoolean(right);
    const booleanValues = aTruth !== undefined && bTruth !== undefined;
    const rawValueDifference = aValue !== undefined && bValue !== undefined && aValue !== bValue;
    // "Amount is 6000" and "amount is not 8000" can both be true. Two
    // denials of different amounts likewise are not mutually inconsistent.
    const differentValue = rawValueDifference && (booleanValues || (left.polarity !== 'denied' && right.polarity !== 'denied'));
    const oppositePolarity = booleanValues ? aTruth !== bTruth
      : left.polarity !== 'uncertain' && right.polarity !== 'uncertain' && left.polarity !== right.polarity
        && !rawValueDifference;
    const overlappingTimes = left.time.start !== null && left.time.end !== null && right.time.start !== null && right.time.end !== null
      && left.time.start <= right.time.end && right.time.start <= left.time.end;
    const differentEventTime = sameKey && leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime && !overlappingTimes;
    if (!differentValue && !oppositePolarity && !differentEventTime) {
      const grounded = left.uncertainty.length === 0 && right.uncertainty.length === 0
        && left.origin !== 'inference' && right.origin !== 'inference'
        && left.polarity !== 'uncertain' && right.polarity !== 'uncertain';
      const timeAligned = sameTime || (sameKey && leftTime === rightTime) || (samePeriod && !leftTime && !rightTime);
      const unitAligned = left.value.unit === right.value.unit && (left.value.kind !== 'money' || left.value.unit !== null);
      const basisKnown = left.basis !== null && right.basis !== null || sameKey;
      if (aValue !== undefined && aValue === bValue && comparableValueKinds && strongSubject && strongObject
        && sameType && (sameKey || samePeriod || sameTime) && compatiblePeriod && compatibleBasis && basisKnown
        && timeAligned && unitAligned && compatibleQualifiers && left.polarity === right.polarity && grounded) {
        relation('equivalent_claim', pair, 'confirmed', '人物、事项、期间/时间、口径与结构化值一致，表达可归组；原话、版本与各自出处均保留。');
      }
      continue;
    }
    // Version corrections are one material's history, not independent conflicting accounts.
    if (sameMaterialDifferentVersions(a, b)) {
      conflict(pair, 'source_version', 'different_scope', '差异来自同一材料的不同文字版本，应对照版本修订核对，不作为两份独立材料的事实冲突。');
      continue;
    }
    if (subject === 'different' || object === 'different') {
      conflict(pair, subject === 'different' ? 'subject' : 'object', 'different_scope', '明确身份标识或主体类型不同，属于不同参与对象，数值或说法差异不能直接视为同一事项的矛盾。');
      continue;
    }
    if (!sameType || (left.event.key !== null && right.event.key !== null && !sameKey)) {
      conflict(pair, 'event', 'different_scope', '事件类型或明确事件标识不同，先分别保留，不能仅按相同主题比较为冲突。');
      continue;
    }
    if (left.period !== null && right.period !== null && !samePeriod) {
      conflict(pair, 'period', 'different_scope', '两条记录所属期间不同，金额或说法差异不直接构成同一期间的冲突。');
      continue;
    }
    if (left.basis !== null && right.basis !== null && !compatibleBasis) {
      conflict(pair, 'basis', 'different_scope', `比较口径不同（${left.basis} / ${right.basis}），应先确认口径，不能直接比较为矛盾。`);
      continue;
    }
    if (left.value.unit !== null && right.value.unit !== null && left.value.unit !== right.value.unit) {
      conflict(pair, 'unit', 'different_scope', '单位或币种不同，尚未进行有依据的换算，不能直接比较数值。');
      continue;
    }
    if (conflictingQualifiers(left, right)) {
      conflict(pair, 'qualifiers', 'different_scope', '限定条件或叙述时点（如 asOf）不同；可能是条件差异或状态变化，不能直接认定冲突。');
      continue;
    }
    if (!sameKey && leftTime && rightTime && leftTime !== rightTime) {
      conflict(pair, 'time', 'different_scope', '时间范围不同且没有明确同一事件标识，差异可能来自不同事件或状态变化。');
      continue;
    }
    const missing: string[] = [];
    if (!strongSubject) missing.push('同一主体');
    if (!strongObject) missing.push('同一作用对象');
    if (!sameKey && !samePeriod && !sameTime) missing.push('同一事件、明确期间或时间');
    if ((left.event.key === null) !== (right.event.key === null)) missing.push('事件标识对应');
    if ((left.period === null) !== (right.period === null)) missing.push('期间对应');
    if ((left.basis === null) !== (right.basis === null) || (!sameKey && left.basis === null && right.basis === null)) missing.push('比较口径');
    if ((leftTime === undefined) !== (rightTime === undefined)) missing.push('时间对应');
    if (!compatibleQualifiers) missing.push('限定条件对应');
    if ((left.value.unit === null) !== (right.value.unit === null)
      || (left.value.kind === 'money' && right.value.kind === 'money' && left.value.unit === null)) missing.push('单位或币种');
    if (!comparableValueKinds) missing.push('同类数值或属性');
    if (missing.length > 0) {
      conflict(pair, differentEventTime ? 'time' : oppositePolarity ? 'polarity' : 'value',
        subject === 'possible' || sameKey ? 'possible_conflict' : 'insufficient_context',
        `记录存在差异，但尚缺${missing.join('、')}等比较条件，保留为待核对项。`);
      continue;
    }
    const grounded = left.uncertainty.length === 0 && right.uncertainty.length === 0
      && left.origin !== 'inference' && right.origin !== 'inference'
      && left.polarity !== 'uncertain' && right.polarity !== 'uncertain';
    const textDifference = left.value.kind === 'text' && right.value.kind === 'text' && differentValue && !oppositePolarity;
    const knownValue = aValue !== undefined && bValue !== undefined;
    const classification = grounded && !textDifference && (knownValue || differentEventTime) ? 'inconsistent' : 'possible_conflict';
    if (differentEventTime) conflict(pair, 'time', classification,
      grounded ? '明确同一事件的时间记载不同；列出两处原文核对，尚不判断哪一处真实。' : '同一事件的时间记载有差异，但含推断或不确定项，需人工复核。');
    if (differentValue || oppositePolarity) conflict(pair, oppositePolarity ? 'polarity' : 'value', classification,
      textDifference ? '相同可比上下文下的文字值不同，可能是补充或差异，尚不能仅据字符串不同确认矛盾。'
        : grounded ? '同一主体、事项、期间/时间、口径和单位下，数值或肯否记载不一致；保留双方出处，尚不判断哪一方真实。'
          : '可比上下文下存在差异，但包含近似、推断或不确定信息，仅列为疑似冲突。');
  }
  return { entities, relations: [...relationMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    conflicts: [...conflictMap.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
