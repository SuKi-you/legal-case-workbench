import type { EntityView, FindingView, RecordView, RunView } from './contracts.ts';

type Conflict = NonNullable<NonNullable<RunView['information']>['conflicts']>[number];
const known = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim().length > 0;
const normalized = (value: string) => value.normalize('NFKC').trim();

function entityKey(entity: EntityView | null | undefined): string | undefined {
  if (!entity) return undefined;
  const identity = entity.identity;
  if (identity) return `${normalized(identity.scheme)}:${normalized(identity.value)}`;
  return known(entity.name) ? `${entity.kind}:${normalized(entity.name)}` : undefined;
}

/** True = comparable context, false = explicitly different, undefined = unresolved. */
export function comparableClaims(a: FindingView, b: FindingView, conflicts: readonly Conflict[] = []): boolean | undefined {
  const paired = conflicts.filter(item => item.findingIds.includes(a.id) && item.findingIds.includes(b.id));
  if (paired.some(item => item.classification === 'different_scope')) return false;
  if (paired.some(item => item.classification === 'inconsistent')) return true;
  if (paired.length > 0) return undefined;
  const left = a.record, right = b.record;
  if (!left || !right || left.topic !== right.topic) return undefined;
  let participantsIdentified = true;
  for (const role of ['subject', 'object'] as const) {
    const x = entityKey(left[role]), y = entityKey(right[role]);
    if (x !== undefined && y !== undefined && x !== y) return false;
    if (x === undefined || y === undefined) return undefined;
    if (!left[role]?.identity || !right[role]?.identity) participantsIdentified = false;
  }
  if (known(left.event?.key) && known(right.event?.key) && left.event.key !== right.event.key) return false;
  for (const field of ['period', 'basis'] as const) {
    if (known(left[field]) && known(right[field]) && normalized(left[field]) !== normalized(right[field])) return false;
  }
  for (const [key, value] of Object.entries(left.qualifiers ?? {})) {
    const other = right.qualifiers?.[key];
    if (other !== undefined && normalized(value) !== normalized(other)) return false;
  }
  const leftTime = left.time, rightTime = right.time;
  if (known(leftTime?.start) && known(leftTime?.end) && known(rightTime?.start) && known(rightTime?.end)
    && (leftTime.end < rightTime.start || rightTime.end < leftTime.start)) return false;
  const sameKey = known(left.event?.key) && left.event.key === right.event?.key;
  const sameTime = known(leftTime?.start) && known(leftTime?.end) && known(rightTime?.start) && known(rightTime?.end)
    && !['unknown', 'relative'].includes(leftTime.precision ?? 'unknown')
    && !['unknown', 'relative'].includes(rightTime.precision ?? 'unknown')
    && leftTime.start === rightTime.start && leftTime.end === rightTime.end;
  // A month alone does not identify an event: two notices can be issued in it.
  return participantsIdentified && (sameKey || sameTime) ? true : undefined;
}

/** Monthly absence must be inferred within one participant/currency/basis series. */
export function periodSeriesKey(finding: FindingView): string {
  const record: RecordView | null | undefined = finding.record;
  const subject = entityKey(record?.subject), object = entityKey(record?.object);
  if (!subject || !object) return `unresolved:${finding.id}`;
  const qualifiers = Object.entries(record?.qualifiers ?? {}).map(([key, value]) => [normalized(key), normalized(value)])
    .sort(([left], [right]) => left!.localeCompare(right!));
  return JSON.stringify([record?.topic, subject, object, record?.basis ?? null, record?.value?.kind ?? null, record?.value?.unit ?? null, qualifiers]);
}
