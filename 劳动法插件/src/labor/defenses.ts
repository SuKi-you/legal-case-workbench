/**
 * 劳动法知识包 · 抗辩库
 *
 * 抗辩描述"对方可能怎么打"，与要件判定解耦：
 * - requires 表示提出该抗辩所需的事实是否已具备，不等于抗辩一定成立；
 * - signals 是材料中的线索词，用于发现迹象；
 * - response 是我方要准备或补充的材料，直接对应承办人的下一步动作。
 */
import type { DefenseSpec } from '../kernel/contracts.ts';

/**
 * 抗辩库：对方最可能提出的反驳。
 *
 * 约定：
 * - requires 描述"提出该抗辩需要哪些事实已具备"，不等于抗辩一定成立；
 * - signals 是线索词，用于从材料表述中发现迹象（如"合作协议""按项目结算"）；
 * - response 是我方要准备或补充的材料，直接对应承办人的下一步动作。
 */
export const LABOR_DEFENSES: readonly DefenseSpec[] = Object.freeze([
  {
    id: 'labor.defense.service',
    name: '双方系劳务关系或合作关系',
    against: ['labor.relationship'],
    requires: [
      { elementId: 'labor.relationship.subordination', in: ['absent'] },
      { elementId: 'labor.relation.form', in: ['satisfied', 'statement_only'] },
    ],
    signals: ['合作协议', '承揽', '外包', '按项目', '合作', '服务协议'],
    effect: 'block', reviewRequired: true, requiresSignal: true,
    response: ['从属性三要素的逐项材料：考勤、排班、请假审批、奖惩记录', '报酬支付的规律性与周期', '劳动是否为业务组成部分'],
    statute: ['labor.relationship.art1', 'labor.relationship.art2'],
    reason: '没有劳动管理记载、又存在协议形式的材料时，对方通常会主张双方系劳务或合作关系，以阻断劳动关系确认及全部派生请求。',
  },
  {
    id: 'labor.defense.part-time',
    name: '非全日制用工',
    against: ['labor.double-wage', 'labor.termination'],
    requires: [{ elementId: 'labor.work.hours', in: ['satisfied', 'statement_only'] }],
    signals: ['非全日制', '小时工', '按小时', '每天四小时', '兼职'],
    effect: 'block', reviewRequired: true, requiresSignal: true,
    response: ['实际出勤时长记录', '计酬与结算周期（是否按小时计酬、是否半月结算）'],
    statute: ['labor.contract.art68', 'labor.contract.art72'],
    reason: '若平均每日不超过四小时、每周累计不超过二十四小时，可能被认定非全日制，从而排除二倍工资与经济补偿。',
  },
  {
    id: 'labor.defense.retirement',
    name: '已达退休年龄或已享受养老保险待遇',
    against: ['labor.relationship'],
    requires: [{ elementId: 'labor.relationship.subject', in: ['satisfied'] }],
    signals: ['退休', '超龄', '养老金', '已达法定退休年龄', '返聘'],
    effect: 'block', reviewRequired: true, requiresSignal: true,
    response: ['身份信息与年龄', '是否已开始领取基本养老保险待遇的记录'],
    statute: ['labor.contract.art44'],
    reason: '已依法享受养老保险待遇的，劳动合同终止，多数地区不再按劳动关系处理；须先核对待遇领取状态。',
  },
  {
    id: 'labor.defense.misconduct',
    claim: { needId: 'labor.need.term-reason', values: ['严重违反规章制度', '严重违纪', '旷工', '违纪'] },
    name: '严重违反规章制度（第 39 条）',
    against: ['labor.termination'],
    requires: [{ elementId: 'labor.termination.reason', in: ['satisfied', 'statement_only'] }],
    signals: ['违纪', '规章制度', '员工手册', '警告', '处分', '旷工'],
    effect: 'block', reviewRequired: true, requiresSignal: true,
    response: ['制度签收或培训记录', '制度是否经民主程序制定并公示', '同类行为的处理先例（是否存在选择性执法）', '违纪证据的完整性与取得方式'],
    statute: ['labor.contract.art39'],
    reason: '单位最常援引的解除依据；但需同时满足内容合法、程序（民主程序+公示）、事实有据、处分相当四项，任何一项缺失都会转为违法解除。',
  },
  {
    id: 'labor.defense.incompetence',
    claim: { needId: 'labor.need.term-reason', values: ['不能胜任工作', '不能胜任'] },
    name: '不能胜任工作（第 40 条）',
    against: ['labor.termination'],
    requires: [{ elementId: 'labor.termination.reason', in: ['satisfied', 'statement_only'] }],
    signals: ['不能胜任', '考核', '绩效', '调岗', '培训'],
    effect: 'block', reviewRequired: true, requiresSignal: true,
    response: ['岗位职责与考核标准的公示或告知材料', '培训或调岗的前置记录', '是否提前三十日通知或支付代通知金'],
    statute: ['labor.contract.art40'],
    reason: '以不能胜任解除必须先经培训或调岗，且需提前三十日通知或支付代通知金；缺任何一步通常构成违法解除。',
  },
  {
    id: 'labor.defense.consensus',
    name: '已协商一致解除',
    against: ['labor.termination'],
    requires: [{ elementId: 'labor.termination.by-agreement', in: ['satisfied', 'statement_only'] }],
    signals: ['协商一致', '和解', '补偿协议', '同意解除', '签了协议'],
    effect: 'block', reviewRequired: true, requiresSignal: true,
    response: ['协议文本与签署过程', '补偿金额是否明显低于法定标准', '协议中"无其他争议"条款的范围'],
    statute: ['labor.contract.art36'],
    reason: '存在解除协议时，单位会主张已协商一致；需核对是否为真实意思表示、补偿是否显失公平。',
  },
  {
    id: 'labor.defense.limitation',
    name: '超过仲裁时效',
    against: ['labor.relationship', 'labor.wage', 'labor.termination', 'labor.double-wage', 'labor.general'],
    requires: [{ elementId: 'labor.termination.date', in: ['satisfied', 'statement_only'] }],
    signals: ['一年前', '超期', '早就', '时效', '过了很久'],
    effect: 'block', reviewRequired: true, requiresSignal: true,
    response: ['主张权利的记录（催讨、投诉、协商）', '拖欠报酬情形下劳动关系是否仍然存续', '是否存在中断或中止事由'],
    statute: ['labor.mediation.art27'],
    reason: '时效是最容易被忽略的抗辩；拖欠劳动报酬在劳动关系存续期间不受一年限制，终止后则自终止之日起算。',
  },
]);
