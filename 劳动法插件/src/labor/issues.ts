/**
 * 劳动法知识包 · 争点与判定规则
 *
 * 规则是数据，不是代码分支：每条规则 = 若干"要件状态期望"的合取，
 * 按顺序求值、首个命中生效，最后一条必须是兜底（all 为空）。
 *
 * 判定的是"事实够不够判断"，不是"请求成不成立"——
 * 后者是承办人的事，本插件只负责把够不够说清楚。
 */
import type { DomainKnowledge, IssueSpec, RoutingRule, Stance } from '../kernel/contracts.ts';
import { LABOR_CHECKS } from './checks.ts';
import { LABOR_DEFENSES } from './defenses.ts';
import { LABOR_ELEMENTS, LABOR_NEEDS } from './elements.ts';
import { LABOR_FACTORS } from './factors.ts';
import { LABOR_OPINIONS } from './opinions.ts';
import { LABOR_SOURCES } from './sources.ts';

const RELATIONSHIP: IssueSpec = {
  id: 'labor.relationship',
  title: '劳动关系确认',
  caseTypes: ['确认劳动关系', '劳动合同纠纷'],
  elements: ['labor.relationship.subject', 'labor.relationship.work', 'labor.relationship.subordination',
    'labor.relationship.business', 'labor.relationship.pay', 'labor.relation.form', 'labor.work.hours'],
  rules: [
    {
      all: [{ elementId: 'labor.relationship.subordination', in: ['conflicting'] }],
      then: 'disputed',
      reason: '劳动管理相关记载相互矛盾，从属性事实本身有争议，须先核对原始记录。',
    },
    {
      all: [{ elementId: 'labor.relationship.subordination', in: ['absent', 'unread'] }],
      then: 'insufficient',
      reason: '劳动管理（从属性）是以定劳动关系的核心要件，现有材料不足以判断；应先补足这部分事实。',
    },
    {
      all: [{ elementId: 'labor.relationship.work', in: ['absent', 'unread'] }],
      then: 'insufficient',
      reason: '实际用工的起止时间与内容不清，无法确定劳动关系存续期间。',
    },
    {
      all: [
        { elementId: 'labor.relationship.subordination', in: ['satisfied'] },
        { elementId: 'labor.relationship.work', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.relationship.pay', in: ['satisfied', 'statement_only'] },
      ],
      then: 'judgeable',
      reason: '主体、实际用工、从属性与报酬支付均有材料支撑，已具备判断劳动关系是否成立的事实基础；对方可能提出劳务或合作关系抗辩，须预留回应。',
    },
    { all: [], then: 'insufficient', reason: '核心要件未同时达到判断要求。' },
  ],
};

const WAGE: IssueSpec = {
  id: 'labor.wage',
  title: '工资支付（含加班费）',
  caseTypes: ['追索劳动报酬', '劳动合同纠纷'],
  elements: ['labor.wage.standard', 'labor.wage.payment', 'labor.wage.period', 'labor.wage.unpaid', 'labor.wage.overtime'],
  rules: [
    {
      all: [{ elementId: 'labor.wage.unpaid', in: ['conflicting'] }],
      then: 'disputed',
      reason: '关于欠付金额或期间的记载相互矛盾，不能自动择一，须先核对。',
    },
    {
      all: [{ elementId: 'labor.wage.payment', in: ['absent', 'unread'] }],
      then: 'insufficient',
      reason: '缺少逐月支付记录，无法区分"确实未发"与"没有记录"；应先调取工资支付凭证或要求单位提供。',
    },
    {
      all: [{ elementId: 'labor.wage.standard', in: ['absent', 'unread'] }],
      then: 'insufficient',
      reason: '工资标准不明，欠付金额无法计算。',
    },
    {
      all: [
        { elementId: 'labor.wage.standard', in: ['satisfied'] },
        { elementId: 'labor.wage.payment', in: ['satisfied'] },
        { elementId: 'labor.wage.unpaid', in: ['satisfied', 'statement_only'] },
      ],
      then: 'judgeable',
      reason: '工资标准、逐月支付记录与欠付期间均有材料支撑，已具备逐月核对与金额测算的事实基础。',
    },
    { all: [], then: 'insufficient', reason: '核心要件未同时达到判断要求。' },
  ],
};

const TERMINATION: IssueSpec = {
  id: 'labor.termination',
  title: '解除与终止',
  caseTypes: ['违法解除赔偿金', '经济补偿', '劳动合同纠纷'],
  elements: [
    'labor.termination.by-employer', 'labor.termination.by-employee', 'labor.termination.by-agreement',
    'labor.termination.form', 'labor.termination.date',
    'labor.termination.reason', 'labor.termination.lastday', 'labor.termination.tenure', 'labor.termination.wagebase',
    'labor.evaluative.misconduct', 'labor.evaluative.agreement-fairness',
  ],
  paths: [
    {
      id: 'labor.path.unilateral',
      name: '单位单方解除（违法则 2N）',
      requires: [
        { elementId: 'labor.termination.by-employer', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.termination.form', in: ['satisfied', 'statement_only'] },
      ],
      blockedBy: ['labor.defense.misconduct', 'labor.defense.incompetence', 'labor.defense.consensus'],
      outcome: '若被认定违法解除，按经济补偿标准的二倍支付赔偿金（2N）',
      calcPath: 'illegal-termination',
      statute: ['labor.contract.art39', 'labor.contract.art40', 'labor.contract.art87', 'labor.ji1.art44'],
      reason: '单位作出解除的记载是本路径的起点；单位对其解除决定的合法性负举证责任，这是本路径最有利的一点。',
    },
    {
      id: 'labor.path.forced',
      name: '劳动者被迫解除（N）',
      requires: [{ elementId: 'labor.termination.by-employee', in: ['satisfied', 'statement_only'] }],
      outcome: '若以第 38 条情形为由解除，按工作年限支付经济补偿（N）',
      calcPath: 'severance',
      statute: ['labor.contract.art38', 'labor.contract.art46'],
      reason: '劳动者提出解除的记载是本路径的起点；是否构成被迫解除取决于解除当时是否以欠薪等法定事由为由，事后补充理由通常不被采纳。',
    },
    {
      id: 'labor.path.consensus',
      name: '协商一致解除（N 或 0）',
      requires: [{ elementId: 'labor.termination.by-agreement', in: ['satisfied', 'statement_only'] }],
      outcome: '单位提出 → N；劳动者提出 → 通常无需补偿；以协议内容为准',
      calcPath: 'severance',
      statute: ['labor.contract.art36', 'labor.contract.art46'],
      reason: '协商一致的记载是本路径的起点；补偿金额取决于由谁提出、协议是否载明补偿以及是否已履行完毕。',
    },
  ],
  rules: [
    {
      all: [{ elementId: 'labor.termination.by-employer', in: ['conflicting'] }],
      then: 'disputed',
      reason: '关于"是否由单位作出解除"的记载相互矛盾，而这一事实直接决定适用哪一条路径，必须先核对。',
    },
    {
      all: [{ elementId: 'labor.termination.by-agreement', in: ['conflicting'] }],
      then: 'disputed',
      reason: '关于"是否协商一致"的记载相互矛盾，须先核对协议或沟通记录。',
    },
    {
      all: [
        { elementId: 'labor.termination.by-employer', in: ['absent', 'unread'] },
        { elementId: 'labor.termination.by-employee', in: ['absent', 'unread'] },
        { elementId: 'labor.termination.by-agreement', in: ['absent', 'unread'] },
      ],
      then: 'insufficient',
      reason: '单位作出／劳动者提出／协商一致这三种起点事实都没有记载，无法确定适用哪一种解除后果；应优先补足解除通知、沟通记录等材料。',
    },
    {
      all: [{ elementId: 'labor.termination.form', in: ['absent', 'unread'] }],
      then: 'insufficient',
      reason: '解除方式与送达形式不明，无法判断解除是否成立、是否违法。',
    },
    {
      all: [
        { elementId: 'labor.termination.by-employer', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.termination.form', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.termination.date', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.termination.tenure', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.termination.wagebase', in: ['satisfied'] },
      ],
      then: 'judgeable',
      reason: '单位作出解除这一起点事实、解除方式、时间、工作年限与前十二个月平均工资均有材料支撑，具备判断解除性质与测算金额的事实基础。',
    },
    {
      all: [
        { elementId: 'labor.termination.by-employee', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.termination.date', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.termination.tenure', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.termination.wagebase', in: ['satisfied'] },
      ],
      then: 'judgeable',
      reason: '劳动者提出解除这一起点事实与测算所需事实均有材料支撑；是否构成被迫解除取决于其解除理由，需另行核实。',
    },
    {
      all: [
        { elementId: 'labor.termination.by-agreement', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.termination.date', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.termination.tenure', in: ['satisfied', 'statement_only'] },
        { elementId: 'labor.termination.wagebase', in: ['satisfied'] },
      ],
      then: 'judgeable',
      reason: '协商一致解除这一起点事实与测算所需事实均有材料支撑；补偿金额取决于由谁提出。',
    },
    { all: [], then: 'insufficient', reason: '核心要件未同时达到判断要求。' },
  ],
};

const DOUBLE_WAGE: IssueSpec = {
  id: 'labor.double-wage',
  title: '未订立书面劳动合同的二倍工资',
  caseTypes: ['二倍工资', '劳动合同纠纷'],
  elements: ['labor.double.start', 'labor.double.signed', 'labor.double.exclusion', 'labor.double.period', 'labor.double.wage'],
  rules: [
    {
      all: [{ elementId: 'labor.double.exclusion', in: ['satisfied'] }],
      then: 'disputed',
      reason: '存在排除二倍工资的主张，须核对解释（二）第七条的具体例外及单位举证；不凭补签、拒签等标签自动排除。',
    },
    {
      all: [{ elementId: 'labor.double.signed', in: ['conflicting'] }],
      then: 'disputed',
      reason: '关于是否订立书面劳动合同的记载相互矛盾，须核对原件后确定。',
    },
    {
      all: [{ elementId: 'labor.double.signed', in: ['unread'] }],
      then: 'insufficient',
      reason: '尚未确认是否存在书面合同，而这是本争点的前提。',
    },
    {
      all: [{ elementId: 'labor.double.start', in: ['absent', 'unread'] }],
      then: 'insufficient',
      reason: '用工之日不清，二倍工资的起算点与仲裁时效都无法确定。',
    },
    {
      all: [{ elementId: 'labor.double.wage', in: ['absent', 'unread'] }],
      then: 'insufficient',
      reason: '计算基数不明，二倍工资无法测算。',
    },
    {
      all: [
        { elementId: 'labor.double.start', in: ['satisfied', 'statement_only'] },
        // 消极事实：材料中没有签订记载（absent）同样足以进入判断。
        { elementId: 'labor.double.signed', in: ['absent', 'satisfied', 'statement_only'] },
        { elementId: 'labor.double.wage', in: ['satisfied'] },
      ],
      then: 'judgeable',
      reason: '用工之日、书面合同的有无与计算基数均已有材料或举证分配支撑；注意二倍工资受一年仲裁时效限制，须单独核算。',
    },
    { all: [], then: 'insufficient', reason: '核心要件未同时达到判断要求。' },
  ],
};

const GENERAL: IssueSpec = {
  id: 'labor.general',
  title: '一般劳动事实整理（兜底）',
  caseTypes: ['其他劳动争议'],
  elements: ['labor.general.events'],
  rules: [
    {
      all: [{ elementId: 'labor.general.events', in: ['satisfied', 'statement_only'] }],
      then: 'judgeable',
      reason: '已形成可核对的事件与材料索引；具体争点尚需结合当事人请求进一步确定。',
    },
    { all: [], then: 'insufficient', reason: '尚未提取到可与材料核对的具体事实。' },
  ],
  routing: [
    {
      id: 'labor.routing.injury',
      when: ['工伤', '受伤', '受伤了', '职业病', '伤残'],
      action: '涉及工伤的，应先申请工伤认定（单位三十日内、劳动者一年内），工伤待遇与劳动争议程序不同，须单列处理。',
      sourceIds: ['labor.injury.art14', 'labor.injury.art17'],
    },
    {
      id: 'labor.routing.social-insurance',
      when: ['社保', '社会保险', '公积金', '补缴'],
      action: '社保补缴多数地区不属于劳动争议仲裁受案范围，应向社保经办机构或劳动监察主张；本整理仅保留相关事实，不作程序结论。',
      sourceIds: ['labor.mediation.art6'],
    },
    {
      id: 'labor.routing.arbitration-first',
      when: ['仲裁', '起诉', '法院'],
      action: '劳动争议一般需先经劳动人事争议仲裁，未经仲裁直接起诉通常不予受理；申请仲裁前请先核对管辖地与一年时效。',
      sourceIds: ['labor.mediation.art27', 'labor.mediation.art47'],
    },
  ],
};

export const LABOR_ISSUES: readonly IssueSpec[] = Object.freeze([RELATIONSHIP, WAGE, TERMINATION, DOUBLE_WAGE, GENERAL]);

/** 案由路由关键词：只作为"先看哪个争点"的提示，不作结论。 */
export const LABOR_ROUTING: readonly RoutingRule[] = Object.freeze([
  { issueId: 'labor.relationship', keywords: ['劳动关系', '从属', '考勤', '排班', '工牌', '安排工作', '请假', '规章制度'] },
  { issueId: 'labor.wage', keywords: ['工资', '欠薪', '拖欠', '报酬', '加班', '加班费', '扣工资', '最低工资', '发工资', '结清'] },
  { issueId: 'labor.termination', keywords: ['辞退', '开除', '解除', '离职', '别来了', '不让来', '停工', '赔偿金', '经济补偿', '调岗', '辞退通知'] },
  { issueId: 'labor.double-wage', keywords: ['没签', '未签', '二倍工资', '双倍工资', '书面劳动合同', '签合同', '劳动合同书'] },
]);

export const LABOR_NOTICES: readonly string[] = Object.freeze([
  '本插件输出的是接案整理结果，不是法律意见，也不预测结果；要件状态只说明"事实够不够判断"。',
  '法源条文须以现行文本核对；地方口径（社平工资、经济补偿封顶、二倍工资时效习惯）尚未装载，涉及地方标准时必须先补参数并核验。',
  '材料记载与当事人陈述不等于已证事实；"未找到记载"不等于"事实不存在"。',
]);

/** 组装知识包。stance 决定缺口后果的措辞（本方/对方），不改变要件与规则。 */
export function buildLaborKnowledge(options: { stance?: Stance; version?: string } = {}): DomainKnowledge {
  return {
    id: 'labor.cn',
    version: options.version ?? '0.6.0',
    domain: '劳动法',
    stance: options.stance ?? 'claimant',
    issues: LABOR_ISSUES,
    elements: LABOR_ELEMENTS,
    sources: LABOR_SOURCES,
    defenses: LABOR_DEFENSES,
    factors: LABOR_FACTORS,
    checks: LABOR_CHECKS,
    opinions: LABOR_OPINIONS,
    fallbackIssueId: 'labor.general',
    routing: LABOR_ROUTING,
    notices: LABOR_NOTICES,
  };
}

export { LABOR_ELEMENTS, LABOR_NEEDS };
