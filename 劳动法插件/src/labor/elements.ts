/**
 * 劳动法知识包 · 需求与要件
 *
 * 两层：
 * - LABOR_NEEDS：进入底座的"信息需求"，决定了模型要从材料里抽取什么；
 * - LABOR_ELEMENTS：要件，决定了抽取结果够不够、缺了谁吃亏。
 *
 * 一份需求可被多个要件共用（例如"工资标准"同时服务于欠薪与二倍工资）。
 * 所有条文编号见 sources.ts；未装载地方口径的，一律在 localCaliber 里写明需核验。
 */
import type { ElementSpec } from '../kernel/contracts.ts';
import type { NeedSpec, StructuredNeed } from '../base.ts';

const spec = (
  topic: string,
  requiredFields: NeedSpec['requiredFields'],
  minimumSupport: 'statement' | 'document',
  extra: Partial<Pick<NeedSpec, 'subject' | 'object' | 'period' | 'basis'>> = {},
): NeedSpec => ({
  topic, subject: extra.subject ?? null, object: extra.object ?? null, period: extra.period ?? null, basis: extra.basis ?? null,
  requiredFields, minimumSupport, applicable: true,
});

export const LABOR_NEEDS: readonly StructuredNeed[] = Object.freeze([
  {
    id: 'labor.need.subject',
    question: '材料显示用人单位与劳动者分别是谁？双方是否具备合法主体资格（单位是否依法设立、劳动者年龄与身份）？逐项保留名称、身份信息与出处。',
    reason: '主体资格是劳动关系成立的第一要件；主体不适格会影响后续所有请求。',
    spec: spec('labor.subject', ['subject', 'object'], 'statement'),
  },
  {
    id: 'labor.need.work',
    question: '材料显示劳动者何时开始、在何处、从事什么内容的工作？是否有明确的到岗或开始提供劳动的记载？',
    reason: '实际用工是劳动关系的起点，也是计算工作年限、工资、时效的基准。',
    spec: spec('labor.work', ['subject', 'object', 'time'], 'statement'),
  },
  {
    id: 'labor.need.subordination',
    question: '材料是否显示单位对劳动者实施考勤、排班、请假审批、奖惩、工作指挥或规章制度约束？逐条保留原始表述。',
    reason: '劳动管理（从属性）是区分劳动关系与劳务、承揽、合作的核心，也是本类案件最常被对方否认的要件。',
    spec: spec('labor.management', ['subject', 'object'], 'statement'),
  },
  {
    id: 'labor.need.business',
    question: '材料是否显示劳动者提供的劳动属于用人单位业务的组成部分（如对外以单位名义服务、使用单位场所设备、纳入单位组织架构）？',
    reason: '业务组成是〔2005〕12号第一条第三项要件，常与从属性互补。',
    spec: spec('labor.business', ['subject', 'object'], 'statement'),
  },
  {
    id: 'labor.need.pay',
    question: '材料显示单位是否向劳动者支付过报酬？金额、周期、支付方式分别是什么？',
    reason: '有规律的报酬支付是劳动关系的重要外观，也直接决定工资金额主张。',
    spec: spec('labor.pay', ['value', 'period', 'time'], 'statement'),
  },
  {
    id: 'labor.need.wage-standard',
    question: '材料如何约定或体现工资标准（数额、计薪方式、是否含奖金补贴、是否含加班费）？约定金额与实际发放金额是否一致？',
    reason: '工资标准是欠薪、加班费、经济补偿、二倍工资全部计算的基数。',
    spec: spec('labor.wage.standard', ['value'], 'document'),
  },
  {
    id: 'labor.need.wage-payment',
    question: '逐笔提取原文明示的工资实际支付时间、所属期间、金额与支付方式。只记载应发、约定或未支付的金额不属于本需求；没有实际支付记载则返回空结果。',
    reason: '只把实际支付记载交给后续逐月比对。月份缺记录与明确未支付分别保存。',
    spec: spec('labor.wage.payment', ['value', 'period', 'time'], 'document'),
  },
  {
    id: 'labor.need.wage-period',
    question: '材料显示工资按什么周期支付（按月、按日、按件），通过什么渠道发放？',
    reason: '支付周期决定欠薪期间的划分与逐月核对的口径。',
    spec: spec('labor.wage.period', ['period', 'basis'], 'statement'),
  },
  {
    id: 'labor.need.wage-unpaid',
    question: '材料显示哪些期间、多少金额的工资未支付或被扣减？当事人对欠付金额的具体表述是什么？',
    reason: '欠付金额是请求金额的直接来源；"未发"与"无记录"必须区分。',
    spec: spec('labor.wage.unpaid', ['value', 'period'], 'statement'),
  },
  {
    id: 'labor.need.overtime',
    question: '材料是否显示具体的加班时间（日期、时长）、加班原因（单位安排或审批）以及是否已支付加班费或安排补休？',
    reason: '加班费主张需要具体时长与安排事实；仅有笼统"经常加班"的表述不足以计算。',
    spec: spec('labor.overtime', ['time', 'value'], 'statement'),
  },
  {
    id: 'labor.need.term-form',
    question: '解除或终止是如何作出的：书面通知、口头通知、微信/短信告知，还是以停止安排工作、结清工资等事实方式作出？有无送达记载？',
    reason: '解除方式与送达决定解除是否成立、是否违法，也决定补偿还是赔偿。',
    spec: spec('labor.term.form', ['value'], 'statement'),
  },
  {
    id: 'labor.need.term-date',
    question: '材料明确记载劳动关系解除或终止自何时生效？只保留明确归属于该事件的日期或原文相对时间，并保留陈述归属。若只有通知发出、送达、最后工作或工资停发日期，且未明确它是生效时间，返回空结果。',
    reason: '区分通知、最后工作与生效时间，为年限、结算及期限核对提供准确输入。',
    spec: spec('labor.term.date', ['time'], 'statement'),
  },
  {
    id: 'labor.need.term.by-employer',
    question: '是否有材料显示解除是由单位作出或通知的（辞退通知、微信告知、停止排班并结清工资等）？原话是什么？',
    reason: '单位作出解除是主张违法解除赔偿金（2N）的起点事实；这一格决定走哪条路径。',
    spec: spec('labor.term.by-employer', [], 'statement'),
  },
  {
    id: 'labor.need.term.by-employee',
    question: '是否有材料显示解除是劳动者提出或主动离职的（辞职申请、离职通知、"我不干了"等）？劳动者当时说明的理由是什么？',
    reason: '劳动者提出解除是主张经济补偿（N，须以第 38 条事由为由）的起点事实，与单位解除的后果完全不同。',
    spec: spec('labor.term.by-employee', [], 'statement'),
  },
  {
    id: 'labor.need.term.by-agreement',
    question: '是否存在双方协商一致解除的记载（解除协议、和解协议、补偿方案、双方确认的沟通记录）？协议由谁起草、是否载明补偿金额？',
    reason: '协商一致解除的补偿取决于"谁提出"：单位提出需付 N，劳动者提出通常不付。',
    spec: spec('labor.term.by-agreement', [], 'statement'),
  },
  {
    id: 'labor.need.work.hours',
    question: '材料显示每日、每周大约工作多少小时？是按小时计酬还是按月计酬？排班由谁决定？',
    reason: '工时与计酬方式决定是否可能构成非全日制用工，也会影响加班与欠薪的计算口径。',
    spec: spec('labor.work.hours', ['value', 'period', 'basis'], 'statement'),
  },
  {
    id: 'labor.need.relation.form',
    question: '双方签署或约定的用工形式是什么：劳动合同、合作协议、承揽/外包协议，还是劳务派遣、挂靠、平台用工？合同上的相对方与实际用工方是否一致？',
    reason: '用工形式是对方最常提出的抗辩入口（劳务关系、外包、派遣），必须在抽取阶段就抓出来。',
    spec: spec('labor.relation.form', ['basis'], 'statement'),
  },
  {
    id: 'labor.need.term-reason',
    question: '单位给出的解除理由是什么（违纪、不能胜任、客观情况变化、裁员等）？有无书面决定或听证、申诉记载？',
    reason: '解除理由是认定合法或违法的依据；单位对其解除决定负举证责任。',
    spec: spec('labor.term.reason', ['value'], 'statement'),
  },
  {
    id: 'labor.need.term-lastday',
    question: '材料明确记载的最后工作日、实际停工日或工资停发日分别是什么？分条保留事件类型、对应日期和陈述归属。只有将来安排而无实际发生记载的，不能作实际发生日期。',
    reason: '不同事件可以有不同日期。先分别记录，后续只比较同一事件的说法。',
    spec: spec('labor.term.lastday', ['time'], 'statement'),
  },
  {
    id: 'labor.need.tenure',
    question: '材料能证明的入职日与离职日分别是哪一天？期间是否有中断、变更用工主体或调岗？',
    reason: '工作年限决定经济补偿月数，也决定二倍工资与年休假等派生请求。',
    spec: spec('labor.tenure', ['time'], 'statement'),
  },
  {
    id: 'labor.need.wage-base12',
    question: '解除或终止前十二个月的应得工资分别是多少？是否包含奖金、津贴、加班费？',
    reason: '经济补偿与赔偿金的月工资基数是前十二个月平均工资，口径直接影响金额。',
    spec: spec('labor.wage.base12', ['value'], 'document'),
  },
  {
    id: 'labor.need.double-start',
    question: '材料显示的最早用工日期是哪一天？该日期本身有无证据支撑？',
    reason: '二倍工资的起算与时效均以用工之日为基准，日期差一个月就可能差一个月工资。',
    spec: spec('labor.tenure.start', ['time'], 'statement'),
  },
  {
    id: 'labor.need.double-signed',
    question: '材料是否显示双方订立过书面劳动合同？如有，签订日期是哪一天？如无，有无催签、拒签的记载？',
    reason: '未订立书面合同的二倍工资以"是否订立"及"签订时间"为前提。',
    spec: spec('labor.double.signed', [], 'document'),
  },
  {
    id: 'labor.need.double-exclusion',
    question: '单位是否主张未签合同因不可抗力、劳动者本人故意或重大过失，或者法律行政法规规定的其他例外所致？有何具体事实、原话和证据？另行保留补签、拒签及用工形式，不能仅凭这些标签认定排除。',
    reason: '二倍工资有法定例外与抗辩空间；不能只问"有没有签"，还要问"有没有不适用的事由"。',
    spec: spec('labor.double.exclusion', [], 'statement'),
  },
  {
    id: 'labor.need.double-period',
    question: '材料能确定的未订立书面合同的起止期间是哪一段（最长不超过十一个月）？',
    reason: '二倍工资按月计算并受时效限制，期间必须逐月确定，不能笼统主张。',
    spec: spec('labor.double.period', ['period'], 'statement'),
  },
  {
    id: 'labor.need.evaluative.misconduct',
    question: '单位主张的违纪行为具体是什么（时间、行为、造成的后果）？所依据的规章制度是否经民主程序、是否已公示或告知？同类行为此前是否有不同处理？',
    reason: '「严重违纪」是评价性判断，需要制度、程序、事实、比例四方面材料；缺任何一面都会影响其成立与否。',
    spec: spec('labor.evaluative.misconduct', [], 'statement'),
  },
  {
    id: 'labor.need.evaluative.fairness',
    question: '解除协议约定的补偿金额是多少？按法定标准应得多少？签署时双方的信息与谈判地位如何，有无催促、误导或趁人之危？',
    reason: '协议是否显失公平，取决于金额差距与签署过程两方面；只问金额会漏掉程序性瑕疵。',
    spec: spec('labor.evaluative.fairness', [], 'document'),
  },
  {
    id: 'labor.need.general',
    question: '材料明确记载了哪些与本起纠纷有关的具体行为、讲话或交易？逐项保留实施者、对象、发生时间和实际内容。',
    reason: '兜底整理：在专业争点尚不明确时，先形成可核对的事件索引。',
    spec: spec('labor.general.event', [], 'statement'),
  },
]);

export const LABOR_ELEMENTS: readonly ElementSpec[] = Object.freeze([
  // ── 争点：劳动关系确认 ──────────────────────────────────────────
  {
    id: 'labor.relationship.subject', issueId: 'labor.relationship', title: '主体资格适格',
    needs: ['labor.need.subject'], critical: true, kind: 'factual', burden: 'claimant',
    materials: ['identity', 'document', 'correspondence'],
    minimumSupport: 'statement', statute: ['labor.relationship.art1'],
    localCaliber: '超龄劳动者、实习生、外籍人员等特殊主体的处理各地口径不同，须逐案核验。',
  },
  {
    id: 'labor.relationship.work', issueId: 'labor.relationship', title: '实际用工事实',
    needs: ['labor.need.work'], critical: true, kind: 'factual', burden: 'claimant',
    materials: ['correspondence', 'financial', 'third_party'],
    minimumSupport: 'statement', statute: ['labor.relationship.art1'],
    localCaliber: '平台用工、外包与劳务派遣的实际用工认定，各地口径差异较大。',
  },
  {
    id: 'labor.relationship.subordination', issueId: 'labor.relationship', title: '劳动管理（从属性）',
    needs: ['labor.need.subordination'], critical: true, kind: 'factual', burden: 'claimant',
    materials: ['correspondence', 'document', 'third_party'],
    minimumSupport: 'statement', statute: ['labor.relationship.art1', 'labor.relationship.art2'],
  },
  {
    id: 'labor.relationship.business', issueId: 'labor.relationship', title: '劳动属业务组成部分',
    needs: ['labor.need.business'], critical: false, kind: 'factual', burden: 'claimant',
    materials: ['document', 'correspondence', 'third_party'],
    minimumSupport: 'statement', statute: ['labor.relationship.art1'],
  },
  {
    id: 'labor.relation.form', issueId: 'labor.relationship', title: '用工形式与协议性质',
    needs: ['labor.need.relation.form'], critical: false, kind: 'factual', burden: 'claimant',
    materials: ['document', 'correspondence'],
    minimumSupport: 'statement', statute: ['labor.relationship.art1'],
    localCaliber: '外包、派遣、挂靠、平台用工的定性各地口径不同，须按本地区规则核验。',
  },
  {
    id: 'labor.work.hours', issueId: 'labor.relationship', title: '工时与计酬方式',
    needs: ['labor.need.work.hours'], critical: false, kind: 'factual', burden: 'claimant',
    materials: ['correspondence', 'document', 'financial'],
    minimumSupport: 'statement', statute: ['labor.contract.art68'],
    localCaliber: '非全日制以平均每日不超过四小时、每周累计不超过二十四小时为界（第 68 条），须以实际考勤核验。',
  },
  {
    id: 'labor.relationship.pay', issueId: 'labor.relationship', title: '报酬支付外观',
    needs: ['labor.need.pay'], critical: true, kind: 'factual', burden: 'claimant',
    materials: ['financial', 'correspondence'],
    minimumSupport: 'statement', statute: ['labor.relationship.art2'],
  },

  // ── 争点：工资支付 ──────────────────────────────────────────────
  {
    id: 'labor.wage.standard', issueId: 'labor.wage', title: '工资标准与计算口径',
    needs: ['labor.need.wage-standard'], critical: true, kind: 'factual', burden: 'claimant',
    materials: ['document', 'correspondence', 'financial'],
    minimumSupport: 'document', statute: ['labor.contract.art30'],
    localCaliber: '二倍工资与经济补偿的工资基数是否包含奖金、加班费，各地口径不同，须按本地区规则核验。',
  },
  {
    id: 'labor.wage.payment', issueId: 'labor.wage', title: '工资实际支付记录（逐月）',
    needs: ['labor.need.wage-payment'], critical: true, kind: 'factual', burden: 'respondent',
    materials: ['financial'],
    minimumSupport: 'document', periodic: true, statute: ['labor.mediation.art6', 'labor.wage.art6'],
    localCaliber: '工资支付凭证保存两年；超过两年的期间可能需另行说明举证困难。',
  },
  {
    id: 'labor.wage.period', issueId: 'labor.wage', title: '支付周期与支付方式',
    needs: ['labor.need.wage-period'], critical: false, kind: 'factual', burden: 'respondent',
    materials: ['financial', 'correspondence'],
    minimumSupport: 'statement', statute: ['labor.law.art50', 'labor.wage.art6'],
  },
  {
    id: 'labor.wage.unpaid', issueId: 'labor.wage', title: '欠付期间与金额',
    needs: ['labor.need.wage-unpaid'], critical: true, kind: 'factual', burden: 'claimant',
    materials: ['financial', 'correspondence'],
    minimumSupport: 'statement', statute: ['labor.contract.art30', 'labor.law.art50'],
  },
  {
    id: 'labor.wage.overtime', issueId: 'labor.wage', title: '加班事实与时长',
    needs: ['labor.need.overtime'], critical: false, kind: 'factual', burden: 'claimant',
    materials: ['correspondence', 'document', 'third_party'],
    minimumSupport: 'statement', statute: ['labor.law.art44', 'labor.ji1.art42'],
    localCaliber: '加班费基数与举证方式各地口径不同；单位掌握考勤记录时的举证责任分担须按本地区规则核验。',
  },

  // ── 争点：解除与终止 ────────────────────────────────────────────
  {
    id: 'labor.termination.form', issueId: 'labor.termination', title: '解除方式与通知形式',
    needs: ['labor.need.term-form'], critical: true, kind: 'factual', burden: 'claimant',
    materials: ['document', 'correspondence', 'statement'],
    minimumSupport: 'statement', statute: ['labor.contract.art38', 'labor.contract.art39', 'labor.contract.art40'],
  },
  {
    id: 'labor.termination.date', issueId: 'labor.termination', title: '解除或终止时间',
    needs: ['labor.need.term-date'], critical: true, kind: 'factual', burden: 'shared',
    materials: ['document', 'correspondence', 'financial'],
    minimumSupport: 'statement', statute: ['labor.contract.art46'],
  },
  // ── 解除的起点事实：三条路径各有自己的入口 ──────────────────────
  {
    id: 'labor.termination.by-employer', expectedPolarity: 'affirmed', issueId: 'labor.termination', title: '单位作出解除',
    needs: ['labor.need.term.by-employer'], critical: false, kind: 'factual', burden: 'respondent',
    materials: ['document', 'correspondence', 'statement'],
    minimumSupport: 'statement', statute: ['labor.contract.art39', 'labor.contract.art40', 'labor.contract.art87'],
  },
  {
    id: 'labor.termination.by-employee', expectedPolarity: 'affirmed', issueId: 'labor.termination', title: '劳动者提出解除',
    needs: ['labor.need.term.by-employee'], critical: false, kind: 'factual', burden: 'claimant',
    materials: ['document', 'correspondence', 'statement'],
    minimumSupport: 'statement', statute: ['labor.contract.art37', 'labor.contract.art38'],
    localCaliber: '劳动者未在离职时明示第 38 条事由、事后补充理由能否获支持，各地口径不同，须核验。',
  },
  {
    id: 'labor.termination.by-agreement', expectedPolarity: 'affirmed', issueId: 'labor.termination', title: '协商一致解除',
    needs: ['labor.need.term.by-agreement'], critical: false, kind: 'factual', burden: 'shared',
    materials: ['document', 'correspondence'],
    minimumSupport: 'statement', statute: ['labor.contract.art36', 'labor.contract.art46'],
  },
  {
    id: 'labor.termination.reason', issueId: 'labor.termination', title: '解除理由',
    needs: ['labor.need.term-reason'], critical: false, kind: 'factual', burden: 'respondent',
    materials: ['document', 'correspondence'],
    minimumSupport: 'statement', statute: ['labor.contract.art39', 'labor.contract.art40'],
  },
  {
    id: 'labor.termination.lastday', issueId: 'labor.termination', title: '最后工作日与工资停发日',
    needs: ['labor.need.term-lastday'], critical: false, kind: 'factual', burden: 'shared',
    materials: ['document', 'financial', 'correspondence'],
    minimumSupport: 'statement', statute: ['labor.wage.art9'],
  },
  {
    id: 'labor.termination.tenure', issueId: 'labor.termination', title: '工作年限',
    needs: ['labor.need.tenure'], critical: true, kind: 'factual', burden: 'respondent',
    materials: ['financial', 'document'],
    minimumSupport: 'statement', statute: ['labor.contract.art47', 'labor.ji1.art44'],
  },
  {
    id: 'labor.termination.wagebase', issueId: 'labor.termination', title: '前十二个月平均工资',
    needs: ['labor.need.wage-base12'], critical: true, kind: 'factual', burden: 'shared',
    materials: ['financial'],
    minimumSupport: 'document', statute: ['labor.contract.art47'],
    localCaliber: '是否剔除病假、停工月份以及是否封顶，按本地区上年度职工月平均工资三倍口径核验。',
  },

  // ── 争点：未签书面合同的二倍工资 ────────────────────────────────
  {
    id: 'labor.double.start', issueId: 'labor.double-wage', title: '用工之日',
    needs: ['labor.need.double-start'], critical: true, kind: 'factual', burden: 'shared',
    materials: ['document', 'financial', 'correspondence'],
    minimumSupport: 'statement', statute: ['labor.contract.art10', 'labor.contract.art82'],
  },
  {
    id: 'labor.double.signed', issueId: 'labor.double-wage', title: '是否订立书面劳动合同',
    needs: ['labor.need.double-signed'], critical: true, kind: 'factual', burden: 'respondent',
    materials: ['document'],
    minimumSupport: 'document', negative: true, statute: ['labor.contract.art10', 'labor.contract.art82'],
  },
  {
    id: 'labor.double.period', issueId: 'labor.double-wage', title: '未签期间（最长十一个月）',
    needs: ['labor.need.double-period'], critical: false, kind: 'factual', burden: 'claimant',
    materials: ['document', 'correspondence'],
    minimumSupport: 'statement', statute: ['labor.contract.art82'],
    localCaliber: '二倍工资的仲裁时效起算口径各地不同（逐月计算或自应签之日起整体计算），须按本地区规则核验。',
  },
  {
    id: 'labor.double.exclusion', expectedPolarity: 'affirmed', issueId: 'labor.double-wage', title: '不适用二倍工资的情形',
    needs: ['labor.need.double-exclusion'], critical: false, kind: 'factual', burden: 'respondent',
    materials: ['document', 'correspondence'], minimumSupport: 'statement',
    statute: ['labor.contract.art82', 'labor.ji2.art7'],
    localCaliber: '解释（二）第七条规定例外并由单位举证；补签、拒签或另有约定本身不自动排除。须核对具体事实与适用期间。',
  },
  {
    id: 'labor.double.wage', issueId: 'labor.double-wage', title: '二倍工资计算基数',
    needs: ['labor.need.wage-standard'], critical: true, kind: 'factual', burden: 'claimant',
    materials: ['financial', 'document'],
    minimumSupport: 'document', statute: ['labor.contract.art82'],
    localCaliber: '二倍工资基数是否包含加班费、奖金，各地口径不同。',
  },

  // ── 评价性要件：不是"有没有"，而是"够不够" ──────────────────────
  {
    id: 'labor.evaluative.misconduct', issueId: 'labor.termination', title: '「严重违纪」是否站得住（评价性）',
    needs: ['labor.need.evaluative.misconduct'], critical: false, kind: 'evaluative', burden: 'respondent',
    materials: ['document', 'correspondence'], minimumSupport: 'statement',
    statute: ['labor.contract.art39'],
    localCaliber: '「严重」的尺度由裁判者综合判断，各地口径不同；本条只提供倾向意见，不作认定。',
  },
  {
    id: 'labor.evaluative.agreement-fairness', issueId: 'labor.termination', title: '解除协议是否显失公平（评价性）',
    needs: ['labor.need.evaluative.fairness'], critical: false, kind: 'evaluative', burden: 'claimant',
    materials: ['document'], minimumSupport: 'document',
    statute: ['civil.code.art151'],
    localCaliber: '显失公平的认定标准与撤销权行使期限（一年）须按本地区裁判口径核验。',
  },

  // ── 兜底争点 ────────────────────────────────────────────────────
  {
    id: 'labor.general.events', issueId: 'labor.general', title: '一般事件与经过',
    needs: ['labor.need.general'], critical: false, kind: 'factual', burden: 'shared',
    materials: ['statement', 'document', 'correspondence', 'financial', 'third_party', 'identity'],
    minimumSupport: 'statement',
  },
]);

/** 诊断用：需求被哪些要件使用（保证没有孤立需求）。 */
export function needUsage(): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const need of LABOR_NEEDS) usage.set(need.id, []);
  for (const element of LABOR_ELEMENTS) {
    for (const needId of element.needs) {
      const list = usage.get(needId);
      if (list) list.push(element.id); else usage.set(needId, [element.id]);
    }
  }
  return usage;
}
