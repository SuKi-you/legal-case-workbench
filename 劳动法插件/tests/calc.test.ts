/**
 * 计算与时效测试：边界、封顶、不自动择高、参数未核验必须标注。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLACEHOLDER_PARAMS, addMonths, arbitrationLimitation, completeMonths, daysBetween,
  doubleWage, illegalTerminationDamages, noticePay, overtimePay, parseDate, segmentedSeverance, severance,
  severanceMonths, type LaborParams,
} from '../src/labor/calc.ts';

const VERIFIED: LaborParams = {
  ...PLACEHOLDER_PARAMS,
  region: '测试地区', effectiveFrom: '2026-01-01',
  averageMonthlyWage: 10_000, verified: true,
  note: '测试用参数',
};

test('经济补偿月数：六个月与整年的分界', () => {
  assert.equal(severanceMonths(0), 0);
  assert.equal(severanceMonths(5), 0.5);
  assert.equal(severanceMonths(6), 1);
  assert.equal(severanceMonths(11), 1);
  assert.equal(severanceMonths(12), 1);
  assert.equal(severanceMonths(17), 1.5);
  assert.equal(severanceMonths(18), 2);
  assert.equal(severanceMonths(23), 2);
  assert.equal(severanceMonths(24), 2);
  assert.equal(severanceMonths(30), 3);
  assert.equal(severanceMonths(36), 3);
  assert.equal(severanceMonths(39), 3.5);
  // 非法输入不产生负数月数
  assert.equal(severanceMonths(-3), 0);
  assert.equal(severanceMonths(Number.NaN), 0);
});

test('三倍封顶：超过社平三倍时按三倍计，并限制年限', () => {
  const capped = severance(40_000, 120, VERIFIED);
  assert.equal(capped.value.base, 30_000);
  assert.equal(capped.value.capped, true);
  assert.equal(capped.value.months, 10);
  assert.equal(capped.value.amount, 300_000);

  const below = severance(8_000, 39, VERIFIED);
  assert.equal(below.value.capped, false);
  assert.equal(below.value.months, 3.5);
  assert.equal(below.value.amount, 28_000);
  assert.ok(below.sources.includes('labor.contract.art47'));
});

test('参数未核验时必须显式标注，不得当作结论', () => {
  const result = severance(8_000, 39, PLACEHOLDER_PARAMS);
  assert.equal(result.verified, false);
  assert.ok(result.assumptions.some((item) => item.includes('未装载')) || result.assumptions.some((item) => item.includes('未核验')));
  assert.match(result.formula, /经济补偿/u);
});

test('违法解除赔偿金是经济补偿的二倍，且明示不与其他路径自动择一', () => {
  const result = illegalTerminationDamages(8_000, 39, VERIFIED);
  assert.equal(result.value.compensationAmount, 28_000);
  assert.equal(result.value.amount, 56_000);
  assert.ok(result.assumptions.some((item) => item.includes('不作结论')));
  assert.ok(result.assumptions.some((item) => item.includes('不由本工具自动择一')));
});

test('代通知金按一个月工资计', () => {
  assert.equal(noticePay(8_000, VERIFIED).value.amount, 8_000);
  assert.ok(noticePay(8_000, VERIFIED).assumptions.some((item) => item.includes('第四十条')));
});

test('二倍工资封顶十一个月', () => {
  const result = doubleWage(6_000, 15, VERIFIED);
  assert.equal(result.value.months, 11);
  assert.equal(result.value.amount, 66_000);
  assert.equal(result.value.exceeded, true);
  assert.ok(result.assumptions.some((item) => item.includes('仲裁时效')));

  assert.equal(doubleWage(6_000, 3, VERIFIED).value.amount, 18_000);
});

test('加班费按 21.75 天折算，倍数取自参数', () => {
  const result = overtimePay(8_000, { weekday: 8, restDay: 0, holiday: 0 }, VERIFIED);
  assert.equal(result.value.hourlyWage, 45.98);
  assert.equal(result.value.amount, 551.72);
  assert.ok(result.assumptions.some((item) => item.includes('综合计算工时')));
});

test('日期工具：月末夹取与完整月数', () => {
  assert.equal(parseDate('2024-02-29') !== null, true);
  assert.equal(parseDate('2024-02-30'), null);
  assert.equal(parseDate('2024/02/01'), null);

  assert.equal(new Date(addMonths(Date.UTC(2024, 0, 31), 1)).toISOString().slice(0, 10), '2024-02-29');
  assert.equal(new Date(addMonths(Date.UTC(2023, 0, 31), 1)).toISOString().slice(0, 10), '2023-02-28');

  assert.equal(completeMonths(Date.UTC(2022, 2, 1), Date.UTC(2025, 5, 15)), 39);
  assert.equal(completeMonths(Date.UTC(2022, 2, 15), Date.UTC(2025, 5, 14)), 38);
  assert.equal(daysBetween(Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 31)), 30);
});

test('仲裁时效：拖欠报酬存续期间不受一年限制', () => {
  const result = arbitrationLimitation({ from: '2024-01-01', today: '2026-01-01', kind: 'wage', relationOngoing: true }, VERIFIED);
  assert.equal(result.value.status, 'open');
  assert.equal(result.value.deadline, null);
  assert.ok(result.assumptions.some((item) => item.includes('存续期间')));
});

test('仲裁时效：临近与已过的判定', () => {
  const expiring = arbitrationLimitation({ from: '2025-01-01', today: '2025-12-01', kind: 'other', relationOngoing: false }, VERIFIED);
  assert.equal(expiring.value.deadline, '2026-01-01');
  assert.equal(expiring.value.status, 'expiring');
  assert.equal(expiring.value.daysLeft, 31);

  const expired = arbitrationLimitation({ from: '2025-01-01', today: '2026-03-01', kind: 'other', relationOngoing: false }, VERIFIED);
  assert.equal(expired.value.status, 'expired');
  assert.ok((expired.value.daysLeft ?? 0) < 0);
});

test('二倍工资时效：地方口径未确认时不作为结论', () => {
  const unconfirmed = arbitrationLimitation({ from: '2025-01-01', today: '2025-06-01', kind: 'double-wage', relationOngoing: false }, VERIFIED);
  assert.equal(unconfirmed.verified, false);
  assert.ok(unconfirmed.assumptions.some((item) => item.includes('地方口径') || item.includes('逐月起算')));

  const confirmed = arbitrationLimitation({ from: '2025-01-01', today: '2025-06-01', kind: 'double-wage', relationOngoing: false, localCaliberConfirmed: true }, VERIFIED);
  assert.equal(confirmed.verified, true);
});

test('起算日无法解析时不猜，返回 unknown', () => {
  const result = arbitrationLimitation({ from: '去年某天', today: '2025-06-01', kind: 'other', relationOngoing: false }, VERIFIED);
  assert.equal(result.value.status, 'unknown');
  assert.equal(result.value.deadline, null);
  assert.equal(result.verified, false);
});

// ── 2008 年分段 ───────────────────────────────────────────────────
test('仲裁时效：中断后自最近一次中断日重新起算', () => {
  const result = arbitrationLimitation({
    from: '2024-01-01', today: '2026-01-01', kind: 'other', relationOngoing: false,
    interruptions: ['2024-06-01', '2025-06-01'],
  }, VERIFIED);
  assert.equal(result.value.startDate, '2025-06-01', '取最晚一次中断');
  assert.equal(result.value.deadline, '2026-06-01');
  assert.match(result.formula, /中断/u);
  assert.ok(result.assumptions.some((item) => item.includes('重新起算')));
});

test('仲裁时效：非法或早于起算日的中断日期被忽略', () => {
  const result = arbitrationLimitation({
    from: '2024-06-01', today: '2025-01-01', kind: 'other', relationOngoing: false,
    interruptions: ['不是日期', '2023-01-01'],
  }, VERIFIED);
  assert.equal(result.value.startDate, '2024-06-01');
  assert.doesNotMatch(result.formula, /中断/u);
});

test('分段经济补偿：跨 2008 年时前后分别计算', () => {
  const result = segmentedSeverance(8_000, '2007-01-01', '2025-01-01', VERIFIED);
  assert.equal(result.value.crossed, true);
  // 前段 2007-01-01 → 2008-01-01 共 12 个月，折算 1 个月
  assert.equal(result.value.pre2008?.months, 1);
  assert.equal(result.value.pre2008?.amount, 8_000);
  // 后段 2008-01-01 → 2025-01-01 共 204 个月，折算 17 个月
  assert.equal(result.value.post2008.months, 17);
  assert.equal(result.value.post2008.amount, 136_000);
  assert.equal(result.value.total, 144_000);
  assert.ok(result.sources.includes('labor.contract.art97'));
  assert.ok(result.assumptions.some((item) => item.includes('第九十七条') || item.includes('当时有关规定')));
});

test('分段经济补偿：未跨 2008 年时等同普通计算', () => {
  const single = severance(8_000, 39, VERIFIED);
  const result = segmentedSeverance(8_000, '2022-03-01', '2025-06-15', VERIFIED);
  assert.equal(result.value.crossed, false);
  assert.equal(result.value.pre2008, null);
  assert.equal(result.value.total, single.value.amount);
  assert.equal(result.value.post2008.months, single.value.months);
});

test('分段经济补偿：日期非法时返回 0 且标注未核验', () => {
  const result = segmentedSeverance(8_000, '2025-01-01', '2020-01-01', VERIFIED);
  assert.equal(result.value.total, null);
  assert.equal(result.calculationStatus, 'not_computed');
  assert.equal(result.verified, false);
  assert.ok(result.assumptions.some((item) => item.includes('无法解析')));
});
