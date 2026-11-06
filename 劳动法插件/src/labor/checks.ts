/**
 * 劳动法知识包 · 专业校验
 *
 * 这些是"看到某种事实组合就必须说一句"的规则，与要件判定、路径、抗辩并列：
 * - 只提示，不下结论；
 * - 条件可以依赖要件状态，也可以依赖材料中的线索词；
 * - 每条都带法源，便于承办人核对。
 */
import type { CheckSpec } from '../kernel/contracts.ts';

export const LABOR_CHECKS: readonly CheckSpec[] = Object.freeze([
  {
    id: 'labor.check.oral-unilateral',
    title: '材料记载单位口头通知，形式与程序仍需核对',
    severity: 'warn',
    when: [
      { elementId: 'labor.termination.by-employer', in: ['satisfied', 'statement_only'] },
      { elementId: 'labor.termination.form', in: ['satisfied', 'statement_only'] },
    ],
    claim: { needId: 'labor.need.term-form', values: ['口头', '口头通知', '口头解除', '口头告知'] },
    message: '材料明确记载口头通知；这不等于已确认没有书面文件。需另行核对书面记录、送达、解除理由及适用的程序要求，保留尚不能判断的条件。',
    statute: ['labor.contract.art39', 'labor.contract.art40', 'labor.contract.art43', 'labor.contract.art87'],
  },
  {
    id: 'labor.check.double-wage-limitation',
    title: '二倍工资须单独核算时效',
    severity: 'info',
    when: [{ elementId: 'labor.double.start', in: ['satisfied', 'statement_only'] }],
    message: '二倍工资受一年仲裁时效限制，且起算口径存在"逐月起算"与"整体起算"两种地方做法，必须单独核算起算日，不能与其他请求一并推定未过时效。',
    statute: ['labor.contract.art82', 'labor.mediation.art27'],
  },
  {
    id: 'labor.check.probation',
    title: '涉及试用期解除',
    severity: 'info',
    when: [{ signal: '试用期' }],
    message: '以试用期不符合录用条件解除的，单位需证明录用条件明确、已告知劳动者，且考核在试用期内完成；仅以"感觉不合适"解除通常不被支持。',
    statute: ['labor.contract.art39'],
  },
  {
    id: 'labor.check.injury-routing',
    title: '可能涉及工伤',
    severity: 'warn',
    when: [{ signal: '工伤' }],
    message: '涉及工伤的，应先申请工伤认定（单位三十日内、劳动者一年内），工伤待遇程序与劳动争议不同，不应与欠薪、赔偿金混在同一程序中主张。',
    statute: ['labor.injury.art14', 'labor.injury.art17'],
  },
  {
    id: 'labor.check.wage-gap-month',
    title: '工资记录存在空月',
    severity: 'info',
    when: [{ elementId: 'labor.wage.payment', in: ['satisfied', 'statement_only'] }],
    gap: { elementId: 'labor.wage.payment', kind: 'missing_period' },
    message: '工资记录中出现没有支付记载的月份时，须区分"确实未发"与"只有记录缺失"：前者是欠薪，后者属于举证范围问题，处理方式不同。',
    statute: ['labor.mediation.art6', 'labor.wage.art6'],
  },
]);
