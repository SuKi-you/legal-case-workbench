/**
 * 劳动法知识包 · 法源登记
 *
 * 约定：
 * - 一条记录 = 一部规范的**一个条文**，便于精确引用与逐条核验；
 * - validity 必须如实：已废止的不得作为现行依据，未核验的必须标 unverified；
 * - 本表仅收录接案阶段最常用的条文，不追求穷尽；引用前须核对现行文本。
 */
import type { DomainSource } from '../kernel/contracts.ts';

const pendingSource = (source: Omit<DomainSource, 'validity' | 'authorityLevel'>): DomainSource =>
  ({ ...source, validity: 'unverified', authorityLevel: 'retrieval' });

export const LABOR_SOURCES: Readonly<Record<string, DomainSource>> = Object.freeze({
  // ── 民法典（撤销与显失公平） ────────────────────────────────────
  'civil.code.art151': pendingSource({
    id: 'civil.code.art151', title: '中华人民共和国民法典', article: '第一百五十一条',
    issuer: '全国人民代表大会',
    note: '一方利用对方处于危困状态、缺乏判断能力等情形，致使民事法律行为成立时显失公平的，受损害方有权请求撤销。',
  }),
  // ── 劳动合同法 ──────────────────────────────────────────────────
  'labor.contract.art10': pendingSource({
    id: 'labor.contract.art10', title: '中华人民共和国劳动合同法', article: '第十条',
    issuer: '全国人民代表大会常务委员会',
    note: '建立劳动关系应当订立书面劳动合同；已建立劳动关系未同时订立的，自用工之日起一个月内订立。',
  }),
  'labor.contract.art30': pendingSource({
    id: 'labor.contract.art30', title: '中华人民共和国劳动合同法', article: '第三十条',
    issuer: '全国人民代表大会常务委员会', note: '用人单位应当按照劳动合同约定和国家规定及时足额支付劳动报酬。',
  }),
  'labor.contract.art36': pendingSource({
    id: 'labor.contract.art36', title: '中华人民共和国劳动合同法', article: '第三十六条',
    issuer: '全国人民代表大会常务委员会', note: '用人单位与劳动者协商一致，可以解除劳动合同。',
  }),
  'labor.contract.art37': pendingSource({
    id: 'labor.contract.art37', title: '中华人民共和国劳动合同法', article: '第三十七条',
    issuer: '全国人民代表大会常务委员会', note: '劳动者提前三十日以书面形式通知用人单位，可以解除劳动合同；试用期内提前三日通知。',
  }),
  'labor.contract.art38': pendingSource({
    id: 'labor.contract.art38', title: '中华人民共和国劳动合同法', article: '第三十八条',
    issuer: '全国人民代表大会常务委员会', note: '劳动者可以解除劳动合同的情形（未提供劳动保护、未足额支付报酬、未缴社保等）。',
  }),
  'labor.contract.art39': pendingSource({
    id: 'labor.contract.art39', title: '中华人民共和国劳动合同法', article: '第三十九条',
    issuer: '全国人民代表大会常务委员会', note: '用人单位可以单方解除的情形（试用期不符合条件、严重违纪、严重失职等）。',
  }),
  'labor.contract.art40': pendingSource({
    id: 'labor.contract.art40', title: '中华人民共和国劳动合同法', article: '第四十条',
    issuer: '全国人民代表大会常务委员会', note: '无过失性辞退：提前三十日书面通知或额外支付一个月工资（代通知金）。',
  }),
  'labor.contract.art43': pendingSource({
    id: 'labor.contract.art43', title: '中华人民共和国劳动合同法', article: '第四十三条',
    issuer: '全国人民代表大会常务委员会', note: '用人单位单方解除劳动合同，应当事先将理由通知工会。',
  }),
  'labor.contract.art44': pendingSource({
    id: 'labor.contract.art44', title: '中华人民共和国劳动合同法', article: '第四十四条',
    issuer: '全国人民代表大会常务委员会',
    note: '劳动合同终止的情形：期满、劳动者开始依法享受基本养老保险待遇、劳动者死亡或被宣告死亡失踪、用人单位破产或被吊销执照等。',
  }),
  'labor.contract.art46': pendingSource({    id: 'labor.contract.art46', title: '中华人民共和国劳动合同法', article: '第四十六条',
    issuer: '全国人民代表大会常务委员会', note: '应当支付经济补偿的具体情形。',
  }),
  'labor.contract.art97': pendingSource({
    id: 'labor.contract.art97', title: '中华人民共和国劳动合同法', article: '第九十七条',
    issuer: '全国人民代表大会常务委员会',
    note: '本法施行前已建立劳动关系、本法施行后解除或终止的，经济补偿年限自本法施行之日（2008 年 1 月 1 日）起计算；本法施行前按照当时有关规定应支付经济补偿的，依照当时有关规定执行。',
  }),
  'labor.contract.art47': pendingSource({    id: 'labor.contract.art47', title: '中华人民共和国劳动合同法', article: '第四十七条',
    issuer: '全国人民代表大会常务委员会',
    note: '经济补偿按工作年限计算，每满一年一个月；六个月以上不满一年按一年，不满六个月按半个月。月工资高于本地区上年度职工月平均工资三倍的，按三倍计，年限最高十二年。',
  }),
  'labor.contract.art82': pendingSource({    id: 'labor.contract.art82', title: '中华人民共和国劳动合同法', article: '第八十二条',
    issuer: '全国人民代表大会常务委员会', note: '自用工之日起超过一个月不满一年未订立书面劳动合同的，每月支付二倍工资；满一年视为订立无固定期限合同。',
  }),
  'labor.contract.art87': pendingSource({
    id: 'labor.contract.art87', title: '中华人民共和国劳动合同法', article: '第八十七条',
    issuer: '全国人民代表大会常务委员会', note: '违法解除或者终止劳动合同的，按经济补偿标准的二倍支付赔偿金。',
  }),

  // ── 劳动法 ──────────────────────────────────────────────────────
  'labor.contract.art68': pendingSource({
    id: 'labor.contract.art68', title: '中华人民共和国劳动合同法', article: '第六十八条',
    issuer: '全国人民代表大会常务委员会',
    note: '非全日制用工是指以小时计酬为主，劳动者在同一用人单位一般平均每日工作时间不超过四小时、每周工作时间累计不超过二十四小时的用工形式。',
  }),
  'labor.contract.art72': pendingSource({
    id: 'labor.contract.art72', title: '中华人民共和国劳动合同法', article: '第七十二条',
    issuer: '全国人民代表大会常务委员会',
    note: '非全日制用工劳动报酬结算支付周期最长不得超过十五日。',
  }),
  'labor.law.art44': pendingSource({
    id: 'labor.law.art44', title: '中华人民共和国劳动法', article: '第四十四条',
    issuer: '全国人民代表大会常务委员会',
    note: '延长工作时间不低于百分之一百五十；休息日且不能补休不低于百分之二百；法定休假日不低于百分之三百。',
  }),
  'labor.law.art50': pendingSource({
    id: 'labor.law.art50', title: '中华人民共和国劳动法', article: '第五十条',
    issuer: '全国人民代表大会常务委员会', note: '工资应当以货币形式按月支付，不得克扣或者无故拖欠。',
  }),

  // ── 劳动争议调解仲裁法 ──────────────────────────────────────────
  'labor.mediation.art6': pendingSource({
    id: 'labor.mediation.art6', title: '中华人民共和国劳动争议调解仲裁法', article: '第六条',
    issuer: '全国人民代表大会常务委员会', note: '与争议事项有关的证据属于用人单位掌握管理的，用人单位应当提供；不提供的承担不利后果。',
  }),
  'labor.mediation.art27': pendingSource({
    id: 'labor.mediation.art27', title: '中华人民共和国劳动争议调解仲裁法', article: '第二十七条',
    issuer: '全国人民代表大会常务委员会',
    note: '仲裁时效期间为一年，自知道或者应当知道权利被侵害之日起计算。劳动关系存续期间因拖欠劳动报酬发生争议的不受一年限制；劳动关系终止的，自终止之日起一年内提出。',
  }),
  'labor.mediation.art47': pendingSource({
    id: 'labor.mediation.art47', title: '中华人民共和国劳动争议调解仲裁法', article: '第四十七条',
    issuer: '全国人民代表大会常务委员会', note: '一裁终局的适用范围（小额请求及标准明确的事项）。',
  }),

  // ── 部门规范性文件与司法解释 ────────────────────────────────────
  'labor.relationship.art1': pendingSource({
    id: 'labor.relationship.art1', title: '关于确立劳动关系有关事项的通知', article: '第一条',
    issuer: '原劳动和社会保障部（劳社部发〔2005〕12号）',
    note: '同时具备三个条件的，劳动关系成立：主体资格合法；劳动者受用人单位劳动管理并从事其安排的有报酬劳动；提供的劳动是用人单位业务的组成部分。',
  }),
  'labor.relationship.art2': pendingSource({
    id: 'labor.relationship.art2', title: '关于确立劳动关系有关事项的通知', article: '第二条',
    issuer: '原劳动和社会保障部（劳社部发〔2005〕12号）',
    note: '认定凭证：工资支付凭证、社保缴费记录、工作证、招工招聘登记表、考勤记录、其他劳动者证言等。',
  }),
  'labor.ji1.art44': pendingSource({
    id: 'labor.ji1.art44', title: '最高人民法院关于审理劳动争议案件适用法律问题的解释（一）', article: '第四十四条',
    issuer: '最高人民法院（法释〔2020〕26号）',
    note: '因用人单位作出开除、除名、辞退、解除劳动合同、减少劳动报酬、计算工作年限等决定而发生的争议，由用人单位负举证责任。',
  }),
  'labor.ji1.art42': pendingSource({
    id: 'labor.ji1.art42', title: '最高人民法院关于审理劳动争议案件适用法律问题的解释（一）', article: '第四十二条',
    issuer: '最高人民法院（法释〔2020〕26号）',
    note: '劳动者主张加班费的，应当就加班事实的存在承担举证责任；但劳动者有证据证明用人单位掌握加班事实存在的证据，用人单位不提供的，由用人单位承担不利后果。',
  }),
  'labor.wage.art6': pendingSource({
    id: 'labor.wage.art6', title: '工资支付暂行规定', article: '第六条',
    issuer: '原劳动部（劳部发〔1994〕489号）', note: '用人单位必须书面记录工资支付情况并保存两年以上。',
  }),
  'labor.wage.art9': pendingSource({
    id: 'labor.wage.art9', title: '工资支付暂行规定', article: '第九条',
    issuer: '原劳动部（劳部发〔1994〕489号）', note: '劳动关系解除或终止时，用人单位应一次付清劳动者工资。',
  }),
  'labor.injury.art14': pendingSource({
    id: 'labor.injury.art14', title: '工伤保险条例', article: '第十四条',
    issuer: '国务院', note: '应当认定为工伤的七种情形（工作时间、工作场所、工作原因等）。',
  }),
  'labor.injury.art17': pendingSource({
    id: 'labor.injury.art17', title: '工伤保险条例', article: '第十七条',
    issuer: '国务院', note: '用人单位应自事故伤害发生之日起三十日内申请工伤认定；劳动者或其近亲属、工会可在一年内申请。',
  }),

  'labor.regulation.art20': {
    id: 'labor.regulation.art20', title: '中华人民共和国劳动合同法实施条例', article: '第二十条', issuer: '国务院',
    validity: 'in-force', authorityLevel: 'statute', effectiveFrom: '2008-09-18', checkedAt: '2026-11-04',
    url: 'https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fg/202011/t20201103_394939_wap.html',
    note: '第四十条额外支付的一个月工资，按照该劳动者上一个月工资标准确定。',
  },
  'labor.ji2.art6': {
    id: 'labor.ji2.art6', title: '最高人民法院关于审理劳动争议案件适用法律问题的解释（二）', article: '第六条', issuer: '最高人民法院（法释〔2025〕12号）',
    validity: 'in-force', authorityLevel: 'statute', effectiveFrom: '2025-09-01', checkedAt: '2026-11-04',
    url: 'https://www.court.gov.cn/zixun/xiangqing/472691.html',
    note: '二倍工资按月计算；不满一个月的按该月实际工作日计算。个案适用期间须另行核验。',
  },
  'labor.ji2.art7': {
    id: 'labor.ji2.art7', title: '最高人民法院关于审理劳动争议案件适用法律问题的解释（二）', article: '第七条', issuer: '最高人民法院（法释〔2025〕12号）',
    validity: 'in-force', authorityLevel: 'statute', effectiveFrom: '2025-09-01', checkedAt: '2026-11-04',
    url: 'https://www.court.gov.cn/zixun/xiangqing/472691.html',
    note: '单位须举证证明不可抗力、劳动者本人故意或者重大过失、法律行政法规规定的其他情形等例外；不能仅以拒签或另有约定自动排除。',
  },

  // ── 地方口径（未核验，禁止直接作为依据） ────────────────────────
  'labor.local.placeholder': {
    id: 'labor.local.placeholder', title: '地方裁判口径（未装载）', issuer: '待补',
    validity: 'unverified', authorityLevel: 'model',
    note: '本知识包尚未装载地方口径（如本地区工资支付办法、社平工资、二倍工资时效起算习惯）。涉及地方标准时必须先补参数包并逐项核验，不得直接引用。',
  },
});
