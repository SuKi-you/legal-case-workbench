/**
 * 劳动法知识包 · 金额与时效
 *
 * 原则（来自设计约定）：
 * - 只做算术，不替承办人选择请求权路径，不在 N / N+1 / 2N 之间"自动择高"；
 * - 每个结果都要能追到公式、参数与假设；
 * - 参数未核验时，结果必须显式标注，不得当定论使用。
 */

export interface LaborParams {
  readonly region: string;
  readonly effectiveFrom: string;
  /** 上年度职工月平均工资；未装载时为 null，封顶规则不得启用。 */
  readonly averageMonthlyWage: number | null;
  /** 月工资高于社平三倍时按三倍计（劳动合同法第四十七条）。 */
  readonly compensationCapFactor: number;
  /** 封顶情形下年限最高十二年。 */
  readonly compensationCapYears: number;
  /** 月计薪天数。 */
  readonly monthlyWorkDays: number;
  readonly overtimeRates: { readonly weekday: number; readonly restDay: number; readonly holiday: number };
  /** 二倍工资最多十一个月。 */
  readonly doubleWageMaxMonths: number;
  /** 仲裁时效十二个月。 */
  readonly arbitrationLimitationMonths: number;
  /** 参数是否已逐项核验。false 时全部结果只能作为草稿。 */
  readonly verified: boolean;
  readonly note: string;
}

/** 占位参数：只用于演示算法形状，数值必须由使用者按本地区核验后替换。 */
export const PLACEHOLDER_PARAMS: LaborParams = Object.freeze({
  region: '未指定地区',
  effectiveFrom: '1970-01-01',
  averageMonthlyWage: null,
  compensationCapFactor: 3,
  compensationCapYears: 12,
  monthlyWorkDays: 21.75,
  overtimeRates: { weekday: 1.5, restDay: 2, holiday: 3 },
  doubleWageMaxMonths: 11,
  arbitrationLimitationMonths: 12,
  verified: false,
  note: '本参数包未核验：社平工资缺失，地方口径未装载。计算结果只能作为测算草稿。',
});

export interface CalcTrace {
  readonly formula: string;
  readonly inputs: Readonly<Record<string, number | string | boolean | null>>;
  readonly assumptions: readonly string[];
  readonly sources: readonly string[];
  /** 参数确认仅说明输入参数的状态，不代表法律适用已经核验。 */
  readonly verified: boolean;
  readonly parametersVerified?: boolean;
  readonly applicabilityVerified?: boolean;
  readonly formulaVersion?: string;
  readonly calculationStatus?: 'computed' | 'not_computed' | 'historical_draft';
}

export interface CalcResult<T> extends CalcTrace {
  readonly value: T;
}

// ── 日期工具（全部按 UTC 处理，避免时区与夏令时干扰） ────────────────
const DAY = 86_400_000;

export function parseDate(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text.trim());
  if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const value = Date.UTC(year, month - 1, day);
  const check = new Date(value);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return value;
}

export const formatDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function addMonths(ms: number, months: number): number {
  const date = new Date(ms);
  const day = date.getUTCDate();
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), Math.min(day, lastDay));
}

export const daysBetween = (from: number, to: number): number => Math.round((to - from) / DAY);

/** 完整月数：不足整月的零头舍去（用于工作年限），day 不足时退一个月。 */
export function completeMonths(from: number, to: number): number {
  const start = new Date(from); const end = new Date(to);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (addMonths(from, months) > to) months -= 1;
  return Math.max(months, 0);
}

/** 保留不足整月的零头；只需标记零头存在即可正确进入半年分档。 */
export function employmentMonths(from: number, to: number): number {
  if (to <= from) return 0;
  const whole = completeMonths(from, to);
  return whole + (addMonths(from, whole) < to ? 0.000001 : 0);
}

// ── 经济补偿月数 ─────────────────────────────────────────────────────
/** 每满一年一个月；六个月以上不满一年按一年；不满六个月按半个月。 */
export function severanceMonths(totalMonths: number): number {
  if (!Number.isFinite(totalMonths) || totalMonths <= 0) return 0;
  const full = Math.floor(totalMonths / 12);
  const remainder = totalMonths % 12;
  const extra = remainder >= 6 ? 1 : remainder > 0 ? 0.5 : 0;
  return full + extra;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface WageBaseApplication {
  readonly base: number;
  readonly capped: boolean;
  readonly capNote: string;
}

/** 月工资基数：有社平工资时套用三倍封顶；参数未核验时必须提示。 */
export function applyWageCap(monthlyWage: number, params: LaborParams): WageBaseApplication {
  if (!Number.isFinite(monthlyWage) || monthlyWage < 0) throw new RangeError('工资必须为非负有限数。');
  if (params.averageMonthlyWage !== null && (!Number.isFinite(params.averageMonthlyWage) || params.averageMonthlyWage <= 0)) throw new RangeError('社平工资必须为正有限数或null。');
  if (monthlyWage <= 0) return { base: 0, capped: false, capNote: '月工资为 0 或未提供，无法计算。' };
  if (params.averageMonthlyWage === null) {
    return { base: monthlyWage, capped: false, capNote: '未装载本地区上年度职工月平均工资，三倍封顶规则未启用；结果可能偏高。' };
  }
  const cap = params.averageMonthlyWage * params.compensationCapFactor;
  return monthlyWage > cap
    ? { base: round2(cap), capped: true, capNote: `月工资高于社平三倍（${round2(cap)}），按三倍封顶计算。` }
    : { base: monthlyWage, capped: false, capNote: '未超过社平三倍，按实际月工资计算。' };
}

// ── 经济补偿 / 赔偿金 / 代通知金 ─────────────────────────────────────
export interface SeveranceResult {
  readonly months: number;
  readonly base: number;
  readonly amount: number;
  readonly capped: boolean;
}

export function severance(monthlyWage: number, totalMonths: number, params: LaborParams): CalcResult<SeveranceResult> {
  if (!Number.isFinite(monthlyWage) || monthlyWage < 0 || !Number.isFinite(totalMonths) || totalMonths < 0) throw new RangeError('工资与任职月数必须为非负有限数。');
  const raw = severanceMonths(totalMonths);
  const wage = applyWageCap(monthlyWage, params);
  const months = wage.capped ? Math.min(raw, params.compensationCapYears) : raw;
  return {
    value: { months, base: wage.base, amount: round2(wage.base * months), capped: wage.capped },
    formula: '经济补偿 = 月工资基数 × 补偿月数；补偿月数按每满一年一个月，六个月以上不满一年按一年，不满六个月按半个月',
    inputs: { monthlyWage, totalMonths, compensationMonths: months, wageBase: wage.base },
    assumptions: [
      wage.capNote,
      `按提供的任职月数 ${totalMonths} 折算；有不足整月的零头须保留为正的小数，或使用起止日期接口。`,
      params.verified ? '参数已核验。' : '参数未核验，结果仅作测算草稿。',
    ],
    sources: ['labor.contract.art47'],
    verified: params.verified, parametersVerified: params.verified, applicabilityVerified: false, formulaVersion: 'labor-calc-2',
  };
}

// ── 2008 年分段的经济补偿 ───────────────────────────────────────────
/** 劳动合同法施行日：此日之前的年限按当时规定计算（第九十七条）。 */
export const CONTRACT_LAW_EFFECTIVE = Date.UTC(2008, 0, 1);

export interface SegmentResult {
  readonly months: number;
  readonly base: number;
  readonly amount: number;
}

export interface SegmentedSeverance {
  readonly total: number | null;
  readonly crossed: boolean;
  /** 2008 年之前的部分；未跨期时为 null。 */
  readonly pre2008: SegmentResult | null;
  readonly post2008: SegmentResult;
}

/**
 * 分段计算：工作年限跨 2008-01-01 的，前后分别计算。
 * 2008 年前按第 97 条"依照当时有关规定执行"，年资月数与上限须按当时规则核验；
 * 本函数把该段的上限设为 12 个月，并把它写进假设里，避免被当成定论。
 */
export function segmentedSeverance(
  monthlyWage: number,
  startDate: string,
  endDate: string,
  params: LaborParams,
): CalcResult<SegmentedSeverance> {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  const wage = applyWageCap(monthlyWage, params);

  if (start === null || end === null || end <= start) {
    return {
      calculationStatus: 'not_computed',
      value: { total: null, crossed: false, pre2008: null, post2008: { months: 0, base: wage.base, amount: 0 } },
      formula: '经济补偿 = 月工资基数 × 补偿月数（跨 2008 年时按劳动合同法第九十七条分段）',
      inputs: { monthlyWage, startDate, endDate },
      assumptions: ['起止日期无法解析或先后颠倒，未作计算。'],
      sources: ['labor.contract.art47', 'labor.contract.art97'],
      verified: false,
    };
  }

  const crossed = start < CONTRACT_LAW_EFFECTIVE && end > CONTRACT_LAW_EFFECTIVE;
  if (!crossed) {
    const single = severance(monthlyWage, employmentMonths(start, end), params);
    return {
      value: {
        total: single.value.amount,
        crossed: false,
        pre2008: null,
        post2008: { months: single.value.months, base: single.value.base, amount: single.value.amount },
      },
      formula: single.formula,
      inputs: { ...single.inputs, startDate, endDate },
      assumptions: ['工作年限未跨 2008-01-01，不适用分段。', '日期区间采用入职日起、解除生效日止的半开区间；若提供的是最后在岗日，应先确认实际解除生效日期。', ...single.assumptions],
      sources: ['labor.contract.art47'],
      verified: params.verified, parametersVerified: params.verified, applicabilityVerified: false, formulaVersion: 'labor-calc-2',
    };
  }

  const preMonthsRaw = severanceMonths(employmentMonths(start, CONTRACT_LAW_EFFECTIVE));
  const preMonths = Math.min(preMonthsRaw, 12);
  const pre: SegmentResult = { months: preMonths, base: monthlyWage, amount: round2(monthlyWage * preMonths) };

  const postWage = applyWageCap(monthlyWage, params);
  const postMonthsRaw = severanceMonths(employmentMonths(CONTRACT_LAW_EFFECTIVE, end));
  const postMonths = postWage.capped ? Math.min(postMonthsRaw, params.compensationCapYears) : postMonthsRaw;
  const post: SegmentResult = { months: postMonths, base: postWage.base, amount: round2(postWage.base * postMonths) };

  return {
    calculationStatus: 'historical_draft',
    value: { total: round2(pre.amount + post.amount), crossed: true, pre2008: pre, post2008: post },
    formula: '经济补偿 = 2008-01-01 前段（按当时规定）+ 后段（劳动合同法第 47 条）；跨期分段依第 97 条',
    inputs: {
      monthlyWage, startDate, endDate,
      preMonths, postMonths, wageBase: postWage.base,
      preAmount: pre.amount, postAmount: post.amount,
    },
    assumptions: [
      '2008-01-01 之前的部分依劳动合同法第 97 条"依照当时有关规定执行"，本测算按每满一年一个月、上限十二个月处理，具体年资月数与上限须按当时规则核验。',
      postWage.capNote,
      '前段未适用三倍社平封顶；若当时规定或本地区口径另有要求，须调整。',
      params.verified ? '参数已核验。' : '参数未核验，结果仅作测算草稿。',
    ],
    sources: ['labor.contract.art47', 'labor.contract.art97'],
    verified: false, parametersVerified: params.verified, applicabilityVerified: false, formulaVersion: 'labor-calc-2',
  };
}

export function illegalTerminationDamages(monthlyWage: number, totalMonths: number, params: LaborParams): CalcResult<SeveranceResult & { compensationAmount: number }> {  const compensation = severance(monthlyWage, totalMonths, params);
  return {
    value: { ...compensation.value, amount: round2(compensation.value.amount * 2), compensationAmount: compensation.value.amount },
    formula: '违法解除赔偿金 = 经济补偿标准 × 2（劳动合同法第八十七条）',
    inputs: { ...compensation.inputs, compensationAmount: compensation.value.amount },
    assumptions: [
      ...compensation.assumptions,
      '本结果仅按"违法解除"路径测算；是否构成违法解除属承办人判断，本插件不作结论。',
      '与代通知金、继续履行等路径互斥，须由承办人选择，不由本工具自动择一。',
    ],
    sources: ['labor.contract.art87'],
    verified: params.verified, parametersVerified: params.verified, applicabilityVerified: false, formulaVersion: 'labor-calc-2',
  };
}

/** lastMonthWage 是上一个月工资，不能传经济补偿的12个月平均工资。 */
export function noticePay(lastMonthWage: number, params: LaborParams): CalcResult<{ amount: number }> {
  if (!Number.isFinite(lastMonthWage) || lastMonthWage < 0) throw new RangeError('上一个月工资必须为非负有限数。');
  return {
    value: { amount: round2(lastMonthWage) },
    formula: '代通知金 = 上一个月工资（劳动合同法实施条例第二十条）',
    inputs: { lastMonthWage, wageBase: lastMonthWage },
    assumptions: [
      '按上一个月工资标准，不适用经济补偿的三倍社平封顶。',
      '仅适用于劳动合同法第四十条情形且选择额外支付一个月工资；适用条件与工资口径须另行确认。',
    ],
    sources: ['labor.contract.art40', 'labor.regulation.art20'],
    verified: params.verified, parametersVerified: params.verified, applicabilityVerified: false, formulaVersion: 'labor-calc-2',
  };
}

// ── 二倍工资 ─────────────────────────────────────────────────────────
export function doubleWage(monthlyWage: number, unsignedMonths: number, params: LaborParams, partial?: { workDays: number; dailyWage: number }): CalcResult<{ months: number; amount: number; exceeded: boolean }> {
  if (!Number.isInteger(unsignedMonths) || unsignedMonths < 0) throw new RangeError('unsignedMonths只接受完整责任月份；不足一个月请提供实际工作日和经确认日工资，不按小数月猜算。');
  if (!Number.isFinite(monthlyWage) || monthlyWage < 0) throw new RangeError('月工资必须为非负有限数。');
  if (partial && (!Number.isInteger(partial.workDays) || partial.workDays < 0 || partial.workDays > 31 || !Number.isFinite(partial.dailyWage) || partial.dailyWage < 0)) throw new RangeError('零头工作日与日工资不合法。');
  const months = unsignedMonths;
  const applied = Math.min(months, params.doubleWageMaxMonths);
  return {
    value: { months: applied, amount: round2(monthlyWage * applied + (applied < params.doubleWageMaxMonths ? (partial?.workDays ?? 0) * (partial?.dailyWage ?? 0) : 0)), exceeded: months > params.doubleWageMaxMonths },
    formula: `二倍工资 = 月工资 × 未订立书面合同月数（最多 ${params.doubleWageMaxMonths} 个月）`,
    inputs: { monthlyWage, unsignedMonths: months, appliedMonths: applied, partialWorkDays: partial?.workDays ?? 0, dailyWage: partial?.dailyWage ?? null },
    assumptions: [
      months > params.doubleWageMaxMonths ? `未签期间 ${months} 个月，超过法定上限，按 ${params.doubleWageMaxMonths} 个月计。` : '未签期间未超过法定上限。',
      '不足一个月按实际工作日；日工资由使用者按适用工资口径确认，不自动用小数月折算。',
      '此处为"另一倍"工资的金额；计算基数是否包含加班费、奖金按地方口径核验。',
      '二倍工资受仲裁时效限制，须结合起算口径另行核算。',
    ],
    sources: ['labor.contract.art82', 'labor.ji2.art6'],
    verified: params.verified, parametersVerified: params.verified, applicabilityVerified: false, formulaVersion: 'labor-calc-2',
  };
}

// ── 加班费 ───────────────────────────────────────────────────────────
export interface OvertimeHours { readonly weekday: number; readonly restDay: number; readonly holiday: number }

export function overtimePay(monthlyWage: number, hours: OvertimeHours, params: LaborParams): CalcResult<{ hourlyWage: number; amount: number; parts: OvertimeHours }> {
  if (!Number.isFinite(monthlyWage) || monthlyWage < 0 || !Number.isFinite(params.monthlyWorkDays) || params.monthlyWorkDays <= 0 || Object.values(hours).some((value) => !Number.isFinite(value) || value < 0)) throw new RangeError('工资、计薪天数或加班时数非法。');
  const hourly = monthlyWage / params.monthlyWorkDays / 8;
  const rate = params.overtimeRates;
  const parts = {
    weekday: round2(hourly * rate.weekday * hours.weekday),
    restDay: round2(hourly * rate.restDay * hours.restDay),
    holiday: round2(hourly * rate.holiday * hours.holiday),
  };
  return {
    value: { hourlyWage: round2(hourly), amount: round2(parts.weekday + parts.restDay + parts.holiday), parts },
    formula: `加班费 = 月工资 ÷ ${params.monthlyWorkDays} ÷ 8 × 加班小时 × 倍数（工作日 ${rate.weekday}／休息日 ${rate.restDay}／法定节假日 ${rate.holiday}）`,
    inputs: { monthlyWage, monthlyWorkDays: params.monthlyWorkDays, ...hours },
    assumptions: [
      '按标准工时制测算；综合计算工时或不定时工时须先确认审批情况，不适用本公式。',
      '休息日加班已安排补休的部分不再支付加班费。',
      '加班费基数是否包含奖金、补贴按地方口径核验。',
    ],
    sources: ['labor.law.art44'],
    verified: params.verified, parametersVerified: params.verified, applicabilityVerified: false, formulaVersion: 'labor-calc-2',
  };
}

// ── 仲裁时效 ─────────────────────────────────────────────────────────
export type LimitationKind = 'wage' | 'other' | 'double-wage';
export type LimitationStatus = 'open' | 'expiring' | 'expired' | 'unknown';

export interface LimitationResult {
  readonly status: LimitationStatus;
  readonly startDate: string | null;
  readonly deadline: string | null;
  readonly daysLeft: number | null;
}

export interface LimitationInput {
  /** 起算日：知道或应当知道权利被侵害之日；拖欠劳动报酬已终止的，为终止之日。 */
  readonly from: string;
  readonly today: string;
  readonly kind: LimitationKind;
  /** 劳动关系是否仍然存续（只影响拖欠劳动报酬）。 */
  readonly relationOngoing: boolean;
  /** 中断事由发生的日期（主张权利、对方同意履行、申请调解仲裁等）。取最晚一次重新起算。 */
  readonly interruptions?: readonly string[];
  /** 二倍工资的起算口径由地方规定，未确认时传 false。 */
  readonly localCaliberConfirmed?: boolean;
}

export function arbitrationLimitation(input: LimitationInput, params: LaborParams): CalcResult<LimitationResult> {
  const from0 = parseDate(input.from);
  const today = parseDate(input.today);
  if (from0 === null || today === null) {
    return {
      value: { status: 'unknown', startDate: null, deadline: null, daysLeft: null },
      formula: '仲裁时效一年，自知道或应当知道权利被侵害之日起算（劳动争议调解仲裁法第二十七条）',
      inputs: { from: input.from, today: input.today, kind: input.kind, relationOngoing: input.relationOngoing },
      assumptions: ['起算日或基准日无法解析，未作计算。'],
      sources: ['labor.mediation.art27'],
      verified: false,
    };
  }

  // 中断：取最晚一次有效中断日作为新的起算日。
  const interruptions = (input.interruptions ?? [])
    .map((text) => ({ text, at: parseDate(text) }))
    .filter((item): item is { text: string; at: number } => item.at !== null && item.at >= from0 && item.at <= today)
    .sort((left, right) => left.at - right.at);
  const lastInterruption = interruptions.at(-1);
  const from = lastInterruption?.at ?? from0;
  const interrupted = lastInterruption !== undefined;

  if (input.kind === 'wage' && input.relationOngoing) {
    return {
      value: { status: 'open', startDate: formatDate(from), deadline: null, daysLeft: null },
      formula: '劳动关系存续期间因拖欠劳动报酬发生争议的，不受一年仲裁时效限制',
      inputs: { from: formatDate(from), today: input.today, relationOngoing: true, interrupted },
      assumptions: ['劳动关系存续期间不计算时效；劳动关系终止后应自终止之日起一年内提出。'],
      sources: ['labor.mediation.art27'],
      verified: params.verified, parametersVerified: params.verified, applicabilityVerified: false, formulaVersion: 'labor-calc-2',
    };
  }

  const deadline = addMonths(from, params.arbitrationLimitationMonths);
  const daysLeft = daysBetween(today, deadline);
  const status: LimitationStatus = daysLeft < 0 ? 'expired' : daysLeft <= 60 ? 'expiring' : 'open';
  const assumptions = [
    '按自然月加十二个月计算，未考虑中止情形。',
    '起算日以使用者提供为准，本工具不推断"知道或应当知道"的时点。',
    ...(interrupted
      ? [`按中断事由重新起算：以 ${formatDate(from)} 为新的起算日（此前的中断日期：${interruptions.map((item) => item.text).join('、')}）。`]
      : []),
  ];
  if (input.kind === 'double-wage' && input.localCaliberConfirmed !== true) {
    assumptions.push('二倍工资时效起算存在"逐月起算"与"整体起算"两种地方口径，本结果未确认适用哪一种，不得直接作为结论。');
  }

  return {
    value: { status, startDate: formatDate(from), deadline: formatDate(deadline), daysLeft },
    formula: interrupted
      ? '仲裁时效 = 最近一次中断日 + 十二个月（劳动争议调解仲裁法第二十七条）'
      : '仲裁时效 = 起算日 + 十二个月（劳动争议调解仲裁法第二十七条）',
    inputs: { from: formatDate(from), today: input.today, kind: input.kind, relationOngoing: input.relationOngoing, daysLeft, interrupted },
    assumptions,
    sources: ['labor.mediation.art27'],
    verified: params.verified && (input.kind !== 'double-wage' || input.localCaliberConfirmed === true),
  };
}
