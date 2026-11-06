import { informationRecordSchema, type InformationRecord } from './contracts.ts';
import { InformationError } from './errors.ts';

function decimal(value: string, power: number): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? '';
  let digits = `${match[2]}${fraction}`;
  const scale = fraction.length - power;
  if (scale < 0) digits += '0'.repeat(-scale);
  if (scale > 0) digits = digits.padStart(scale + 1, '0');
  const split = scale > 0 ? digits.length - scale : digits.length;
  const integer = (digits.slice(0, split) || '0').replace(/^0+(?=\d)/u, '');
  const tail = scale > 0 ? digits.slice(split).replace(/0+$/u, '') : '';
  const normalized = tail ? `${integer}.${tail}` : integer;
  return `${match[1] === '-' && normalized !== '0' ? '-' : ''}${normalized}`;
}
export function normalizeQuantity(raw: string, money: boolean): { normalized: string | null; unit: string | null } {
  const stripped = raw.trim().replace(/^(?:人民币|CNY|￥|¥)\s*/u, '');
  const match = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(万|千)?\s*(元|人民币|CNY|美元|USD|港元|HKD)?$/u.exec(stripped);
  if (!match) return { normalized: null, unit: null };
  const normalized = decimal(match[1]!.replaceAll(',', ''), match[2] === '万' ? 4 : match[2] === '千' ? 3 : 0);
  const unit = /美元|USD/u.test(raw) ? 'USD' : /港元|HKD/u.test(raw) ? 'HKD'
    : /人民币|CNY|￥|¥|元/u.test(raw) ? 'CNY' : null;
  return { normalized, unit: money ? unit : match[3] ?? null };
}
function validDate(year: number, month: number, day: number): string | null {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function normalizeInformationTime(raw: string | null): InformationRecord['time'] {
  if (!raw) return { raw: null, start: null, end: null, precision: 'unknown' };
  const exact = /^(\d{4})(?:年|[-/.])(\d{1,2})(?:月|[-/.])(\d{1,2})日?$/u.exec(raw.trim());
  if (exact) {
    const date = validDate(Number(exact[1]), Number(exact[2]), Number(exact[3]));
    if (date) return { raw, start: date, end: date, precision: 'date' };
  }
  const month = /^(\d{4})(?:年|[-/.])(\d{1,2})月?$/u.exec(raw.trim());
  if (month && Number(month[2]) >= 1 && Number(month[2]) <= 12) {
    const start = validDate(Number(month[1]), Number(month[2]), 1)!;
    const last = new Date(Date.UTC(Number(month[1]), Number(month[2]), 0)).getUTCDate();
    return { raw, start, end: validDate(Number(month[1]), Number(month[2]), last)!, precision: 'month' };
  }
  return { raw, start: null, end: null, precision: /上周|下周|昨天|今天|前天|上月|本月|日前|之后|此后/u.test(raw) ? 'relative' : 'unknown' };
}

/** Canonical fields must be supported by quoted text, not invented by an extractor. */
export function normalizeInformationRecord(input: InformationRecord, evidence: string): InformationRecord {
  const record = informationRecordSchema.parse(input);
  const uncertainty = new Set(record.uncertainty);
  const supported = (raw: string | null, label: string) => {
    if (raw !== null && !evidence.includes(raw)) throw new InformationError('INFORMATION_UNGROUNDED_FIELD', `${label} is absent from the cited excerpts.`);
  };
  for (const role of ['subject', 'object', 'attributedTo'] as const) {
    const entity = record[role];
    if (!entity) continue;
    supported(entity.name, role);
    if (entity.identity) {
      supported(entity.identity.value, `${role}.identity`);
      const schemes: Record<string, string> = { '工号': 'employee_id', '员工号': 'employee_id', '员工编号': 'employee_id', '人员编号': 'personnel_id', '人员号': 'personnel_id', '登记编号': 'registration_id', '身份证号': 'national_id', '身份证号码': 'national_id', '统一社会信用代码': 'organization_id' };
      entity.identity.scheme = schemes[entity.identity.scheme] ?? entity.identity.scheme;
    }
  }
  supported(record.event.key, 'event.key');
  supported(record.time.raw, 'time.raw');
  supported(record.value.raw, 'value.raw');
  supported(record.basis, 'basis');
  // This is an internal concept key, while description retains the source wording.
  record.event.type = record.topic;
  for (const [name, value] of Object.entries(record.qualifiers)) {
    if (!name.trim() || !value.trim()) throw new InformationError('INFORMATION_UNGROUNDED_FIELD', 'Comparison qualifiers must not be blank.');
    if (!evidence.includes(value)) {
      const dates = [...evidence.matchAll(/\d{4}(?:年|[-/.])\d{1,2}(?:月|[-/.])\d{1,2}日?/gu)]
        .map((match) => normalizeInformationTime(match[0]).start);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !dates.includes(value)) {
        throw new InformationError('INFORMATION_UNGROUNDED_FIELD', 'Comparison qualifier is absent from the cited excerpts.');
      }
    }
    const date = normalizeInformationTime(value);
    if (date.precision === 'date') record.qualifiers[name] = date.start!;
  }
  record.time = normalizeInformationTime(record.time.raw);
  if (record.time.raw && !record.time.start) uncertainty.add('time_not_resolved');
  if (record.value.kind === 'money' || record.value.kind === 'number') {
    const quantity = record.value.raw ? normalizeQuantity(record.value.raw, record.value.kind === 'money') : { normalized: null, unit: null };
    record.value.normalized = quantity.normalized;
    record.value.unit = quantity.unit;
    if (quantity.normalized === null) uncertainty.add('value_not_resolved');
  } else if (record.value.kind === 'date') {
    record.value.normalized = normalizeInformationTime(record.value.raw).start;
    record.value.unit = null;
  } else if (record.value.kind === 'boolean') {
    // The boolean is the truth of the positive topic; polarity is not applied twice.
    const raw = record.value.raw ?? '';
    if (/^(?:true|是|已收到|已经收到|已支付|已经支付|已发放)$/iu.test(raw)) record.value.normalized = 'true';
    else if (/^(?:false|否|未收到|没有收到|未支付|没有支付|未发放|没有发放)$/iu.test(raw)) record.value.normalized = 'false';
    else { record.value.normalized = null; uncertainty.add('boolean_not_resolved'); }
    record.value.unit = null;
  } else {
    record.value.normalized = record.value.kind === 'unknown' ? null : record.value.raw;
    record.value.unit = null;
  }
  if (record.period !== null) {
    const candidate = normalizeInformationTime(record.period);
    const month = candidate.start?.slice(0, 7);
    const explicitMonths = [...evidence.matchAll(/(\d{4})(?:年|[-/.])(\d{1,2})(?:月|(?=[-/.\s日，。]))/gu)]
      .map((match) => `${match[1]}-${String(Number(match[2])).padStart(2, '0')}`);
    if (month && explicitMonths.includes(month)) record.period = month;
    else if (!evidence.includes(record.period)) { record.period = null; uncertainty.add('period_not_resolved'); }
    else if (!month) uncertainty.add('period_year_or_range_not_resolved');
  }
  if ((record.value.kind === 'money' || record.value.kind === 'number') && record.value.raw
    && /约|大概|左右|至|到|[~～]/u.test(record.value.raw)) uncertainty.add('approximate_or_ranged_value');
  // Extra qualifiers must not duplicate an already canonical comparison field.
  // Omission of a redundant copy in another record is not a different scope.
  for (const [name, value] of Object.entries(record.qualifiers)) {
    const currency = /^(人民币|CNY|元|￥|¥)$/u.test(value) ? 'CNY' : /^(美元|USD)$/u.test(value) ? 'USD' : /^(港元|HKD)$/u.test(value) ? 'HKD' : null;
    const month = normalizeInformationTime(value).start?.slice(0, 7);
    if ((/^(币种|currency|单位|unit)$/iu.test(name) && currency !== null && currency === record.value.unit)
      || (/^(所属期间|所属月份|期间|period)$/iu.test(name) && month !== undefined && month === record.period)
      || (/^(金额口径|口径|basis)$/iu.test(name) && value === record.basis)
      || (/^(流水号|事件标识|eventKey)$/iu.test(name) && value === record.event.key)) delete record.qualifiers[name];
  }
  if (record.origin === 'inference') uncertainty.add('inference_requires_review');
  record.uncertainty = [...uncertainty];
  return record;
}
