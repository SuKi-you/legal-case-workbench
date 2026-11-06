/**
 * 通用结构层 · 契约
 *
 * 这里只描述"任何部门法的接案整理都需要的东西"，不含任何具体法域名词。
 * 刻意不 import 底座类型：kernel 只认下面这几个"最小只读视图"，
 * 底座真实的 LoopRun / OutputSection 在结构上天然满足它们（见 tests/kernel-generic.test.ts）。
 */

// ── 视角 ─────────────────────────────────────────────────────────────
/** 同一份材料，站不同立场，要件顺序、举证方向、缺口后果都不同。 */
export type Stance = 'claimant' | 'respondent' | 'neutral';

// ── 要件状态 ─────────────────────────────────────────────────────────
export const ELEMENT_STATES = [
  'satisfied',        // 有书证或已核对支持
  'statement_only',   // 仅有陈述，未达本要件的证明要求
  'absent',           // 已核对，但没有对应记载
  'unread',           // 选定材料尚未读取
  'conflicting',      // 记载相互矛盾
  'not_applicable',   // 专业上声明不适用
  'opposed',          // 相关记录明确反对本要件要求的命题
  'needs_review',     // 字段、语义或已读范围仍待核对
] as const;
export type ElementState = (typeof ELEMENT_STATES)[number];

/**
 * 严重度只用于"多需求合并成一个要件"时取最坏值，以及排序。
 * not_applicable 不参与升级：它是专业结论，不是缺口。
 */
const ELEMENT_SEVERITY: Readonly<Record<ElementState, number>> = Object.freeze({
  not_applicable: -1,
  satisfied: 0,
  statement_only: 1,
  absent: 2,
  unread: 3,
  conflicting: 4,
  opposed: 2,
  needs_review: 3,
});

export const elementSeverity = (state: ElementState): number => ELEMENT_SEVERITY[state];

/** 多需求合并：最坏的胜出。空集合视为 absent（没读到任何对应记载）。 */
export function worstState(states: readonly ElementState[]): ElementState {
  let worst: ElementState = 'not_applicable';
  for (const state of states) if (state !== 'not_applicable' && (worst === 'not_applicable' || ELEMENT_SEVERITY[state] > ELEMENT_SEVERITY[worst])) worst = state;
  return states.some((state) => state !== 'not_applicable') ? worst : (states.length === 0 ? 'absent' : 'not_applicable');
}

// ── 争点状态 ─────────────────────────────────────────────────────────
export const ISSUE_STATES = ['judgeable', 'disputed', 'insufficient', 'not_applicable'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

// ── 材料类型（封闭枚举：只有封闭才能被校验、被归类） ──────────────────
export const MATERIAL_KINDS = ['document', 'correspondence', 'financial', 'identity', 'third_party', 'statement'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const MATERIAL_KIND_LABEL: Readonly<Record<MaterialKind, string>> = Object.freeze({
  document: '书面文书',
  correspondence: '往来记录',
  financial: '财务凭证',
  identity: '身份文书',
  third_party: '第三方文书',
  statement: '当事人陈述',
});

// ── 记录字段（与底座 informationRecord 的字段名对齐，便于直接透传） ──
export const RECORD_FIELDS = ['subject', 'object', 'attributedTo', 'event.key', 'time', 'value', 'period', 'basis'] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];

// ── 举证责任 ─────────────────────────────────────────────────────────
export type Burden = 'claimant' | 'respondent' | 'shared' | 'authority';

/**
 * 举证责任的转移条件。
 * when 是若干条件的**合取**（AND）；需要"或"时写多条 shift，按顺序首个命中生效。
 */
export interface BurdenCondition {
  /** 依赖某个要件的当前状态。 */
  readonly elementId?: string;
  readonly in?: readonly ElementState[];
  /** 材料文本中的线索词（如"考勤""工资表"）。 */
  readonly signal?: string;
}

export interface BurdenShift {
  readonly when: readonly BurdenCondition[];
  readonly then: Burden;
  readonly reason: string;
}

// ── 法源 ─────────────────────────────────────────────────────────────
/** 溯源层级：条文原文 / 检索命中 / 模型知识。仅模型知识的必须显式标待核。 */
export type AuthorityLevel = 'statute' | 'retrieval' | 'model';
/** 效力状态：已废止的不能作为现行依据。 */
export type Validity = 'in-force' | 'repealed' | 'historical' | 'unverified';

export interface DomainSource {
  readonly id: string;
  readonly title: string;
  readonly article?: string;
  readonly issuer?: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string;
  readonly validity: Validity;
  readonly authorityLevel: AuthorityLevel;
  readonly region?: string;
  readonly note?: string;
  readonly url?: string;
  readonly checkedAt?: string;
}

/** 能作为判定依据引用，且必须提示"未验证"的情况在这里统一判断。 */
export const sourceUsable = (source: DomainSource): boolean => source.validity !== 'repealed';
export const sourceNeedsReview = (source: DomainSource): boolean =>
  source.validity === 'unverified' || source.authorityLevel === 'model';

// ── 要件 ─────────────────────────────────────────────────────────────
export interface ElementSpec {
  readonly id: string;
  readonly issueId: string;
  readonly title: string;
  /** 进入底座的信息需求 id；一个要件可以由多条需求支撑。 */
  readonly needs: readonly string[];
  /** 核心要件缺失时，争点直接判为材料不足。 */
  readonly critical: boolean;
  readonly kind: 'factual' | 'evaluative';
  /** 信息是否齐备与命题肯否分开；省略时该要件仅检查信息覆盖。 */
  readonly expectedPolarity?: 'affirmed' | 'denied';
  readonly burden: Burden;
  /**
   * 举证责任的转移规则（如"考勤记录由单位掌握时，加班事实的举证责任转移"）。
   * 省略表示本要件不转移。
   */
  readonly burdenShift?: readonly BurdenShift[];
  /** 能证明该要件的材料类型，用于生成补证动作。 */
  readonly materials: readonly MaterialKind[];
  /** 本要件要求"仅陈述"还是"有书证"（字段级要求由 need.spec.requiredFields 承载，避免两处重复）。 */
  readonly minimumSupport?: 'statement' | 'document';
  /**
   * 消极事实要件（如"未订立书面合同"）。
   * 材料中没有相反记载时，举证责任落在主张该事实存在的对方，缺材料不构成本方举证不能。
   */
  readonly negative?: boolean;
  /**
   * 周期性要件（如按月发薪）。
   * 开启后会在"已出现的期间范围内"逐月比对，找出空月——缺某个月是接案最常见的实质问题。
   */
  readonly periodic?: boolean;
  /** 法源 id，指向 DomainKnowledge.sources。 */
  readonly statute?: readonly string[];
  /** 地方口径提示（不参与判定，只做说明）。 */
  readonly localCaliber?: string;
}

// ── 争点与规则 ───────────────────────────────────────────────────────
export interface ElementExpectation {
  readonly elementId: string;
  readonly in: readonly ElementState[];
}

/** 一条规则 = 若干期望的合取（DNF）；规则按顺序求值，首个命中生效。 */
export interface IssueRule {
  readonly all: readonly ElementExpectation[];
  readonly then: IssueState;
  readonly reason: string;
}

// ── 路径：同一争点下的多条法律路径 ───────────────────────────────────
/**
 * 路径描述"可以怎么主张"，与争点状态正交：
 * 争点状态回答"事实够不够判断"，路径回答"有哪几条路、各自还差什么"。
 * 路径永远并列输出，不排序、不推荐、不择高。
 */
export interface PathSpec {
  readonly id: string;
  readonly name: string;
  /** 该路径成立所需的条件，与规则共用同一套"要件状态期望"词汇。 */
  readonly requires: readonly ElementExpectation[];
  /** 命中这些抗辩且抗辩已成立时，本路径被阻断。 */
  readonly blockedBy?: readonly string[];
  /** 结果描述（如"2N = 经济补偿的二倍"），不写具体数字。 */
  readonly outcome: string;
  /** 对应金额测算路径名（由计算工具解释），仅作提示，不在判定时自动计算。 */
  readonly calcPath?: string;
  readonly statute: readonly string[];
  readonly reason: string;
}

// ── 抗辩：对方可能提出的反驳 ─────────────────────────────────────────
export type DefenseEffect = 'block' | 'reduce' | 'shift_burden';

/**
 * 抗辩是"假想"，没有出处可引，因此只走工具输出，不进入成果区块的结论性表述。
 * signals 是线索词：命中即把"可能性"从 unlikely 提到 possible，用于发现迹象。
 */
export interface DefenseSpec {
  readonly id: string;
  readonly name: string;
  /** 针对哪些争点。 */
  readonly against: readonly string[];
  /** 抗辩成立需要满足的条件。 */
  readonly requires: readonly ElementExpectation[];
  /** 材料中的线索词，用于把"没有迹象"和"有迹象"区分开。 */
  readonly signals?: readonly string[];
  /** 专业条件尚需核实的抗辩只提示候选，不得阻断路径。 */
  readonly reviewRequired?: boolean;
  readonly requiresSignal?: boolean;
  /** 精确的结构化主张值，不能仅凭同主题记录判为条件成立。 */
  readonly claim?: { readonly needId: string; readonly values: readonly string[] };
  readonly effect: DefenseEffect;
  /** 我方回应需要补充或准备的材料。 */
  readonly response: readonly string[];
  readonly statute: readonly string[];
  readonly reason: string;
}

// ── 事实因子：把若干要件的状态聚合成一个可解释的强度 ────────────────
/**
 * 因子不是结论，是一个"有据可查的加权分"：
 * satisfied 计满权重，statement_only 计一半，其余计 0；再除以总权重得到 0–1 的分。
 * 分档只给"弱/中/强"这类提示，不产出概率，也不替代法律认定。
 */
export interface FactorWeight {
  readonly elementId: string;
  readonly weight: number;
}

export interface FactorBand {
  /** 达到该分值即落入此档（从高到低匹配）。 */
  readonly min: number;
  readonly label: string;
  readonly note: string;
}

export interface FactorSpec {
  readonly id: string;
  readonly title: string;
  readonly issueId: string;
  readonly parts: readonly FactorWeight[];
  readonly bands: readonly FactorBand[];
  readonly note: string;
}

export interface FactorAssessment {
  readonly factorId: string;
  readonly title: string;
  readonly issueId: string;
  readonly score: number;
  readonly band: string;
  readonly bandNote: string;
  readonly contributions: readonly {
    readonly elementId: string;
    readonly state: ElementState;
    readonly weight: number;
    readonly points: number;
  }[];
  readonly note: string;
}

// ── 专业校验：某些事实组合一旦出现，就必须提示 ──────────────────────
export type CheckSeverity = 'info' | 'warn' | 'critical';

export interface CheckSpec {
  readonly id: string;
  readonly title: string;
  readonly severity: CheckSeverity;
  /** 状态/线索词条件（合取）。可为空，但 when、claim、gap 至少提供一个有效条件，所有已提供条件均须满足。 */
  readonly when: readonly BurdenCondition[];
  /** A concrete recorded value, rather than a source/support category. */
  readonly claim?: { readonly needId: string; readonly values: readonly string[] };
  /** Computed gaps can trigger a reminder without guessing from data presence. */
  readonly gap?: { readonly elementId: string; readonly kind: GapKind };
  readonly message: string;
  readonly statute: readonly string[];
}

export interface CheckAssessment {
  readonly checkId: string;
  readonly title: string;
  readonly severity: CheckSeverity;
  readonly message: string;
  readonly statute: readonly string[];
}

/** 证明任务：由缺口派生，直接对应"补什么、补到什么程度"。 */
export interface ProofTask {
  readonly id: string;
  readonly elementId: string;
  readonly issueId: string;
  readonly goal: string;
  readonly materials: readonly MaterialKind[];
  readonly standard: 'statement' | 'document';
  readonly burden: Burden;
  readonly basis: string;
  readonly gapKind: GapKind;
}

// ── 评价性要件的参考意见（需要模型） ────────────────────────────────
export type Tendency = 'likely' | 'unlikely' | 'unclear';
export type Confidence = 'low' | 'medium' | 'high';

/**
 * 评价性要件的提问模板。
 * 只由插件提供"问什么、必须考虑哪些因素"，模型负责给出倾向与理由；
 * 模型永远不改变 element.state，也永远不产出"成立/不成立"。
 */
export interface OpinionSpec {
  readonly elementId: string;
  readonly question: string;
  readonly factors: readonly string[];
  readonly guidance?: string;
}

export interface OpinionCitation {
  readonly findingId: string;
  /** 必须能在该 finding 的原文引用中逐字找到，归纳陈述不能作为原文。 */
  readonly quote: string;
}

export interface Opinion {
  readonly elementId: string;
  readonly tendency: Tendency;
  readonly confidence: Confidence;
  readonly reasoning: string;
  readonly citations: readonly OpinionCitation[];
  readonly missingFactors: readonly string[];
}

export interface IssueSpec {
  readonly id: string;
  readonly title: string;
  /** 案由/请求类型标签，仅用于展示与路由说明。 */
  readonly caseTypes: readonly string[];
  /** 本争点下必须评估的要件（顺序即展示顺序）。 */
  readonly elements: readonly string[];
  readonly rules: readonly IssueRule[];
  /** 同一争点下的多条法律路径；省略表示该方法域没有分立路径。 */
  readonly paths?: readonly PathSpec[];
  /** 程序分流：命中时提示"先走别的程序"，不参与要件判定。 */
  readonly routing?: readonly RoutingHint[];
}

export interface RoutingHint {
  readonly id: string;
  readonly when: readonly string[];
  readonly action: string;
  readonly sourceIds?: readonly string[];
}

export interface RoutingRule {
  readonly issueId: string;
  readonly keywords: readonly string[];
}

// ── 知识包 ───────────────────────────────────────────────────────────
export interface DomainKnowledge {
  readonly id: string;
  readonly version: string;
  /** 人类可读的法域名，仅用于输出标题。 */
  readonly domain: string;
  readonly stance: Stance;
  readonly issues: readonly IssueSpec[];
  readonly elements: readonly ElementSpec[];
  readonly sources: Readonly<Record<string, DomainSource>>;
  /** 对抗辩库；省略表示本知识包不维护抗辩。 */
  readonly defenses?: readonly DefenseSpec[];
  /** 事实因子（加权评分）；省略表示不做因子聚合。 */
  readonly factors?: readonly FactorSpec[];
  /** 专业校验：事实组合一旦出现就必须提示；省略表示不做校验。 */
  readonly checks?: readonly CheckSpec[];
  /** 评价性要件的提问模板；省略表示不做模型评估。 */
  readonly opinions?: readonly OpinionSpec[];
  /** 路由无命中时的兜底争点。 */
  readonly fallbackIssueId: string;
  readonly routing?: readonly RoutingRule[];
  /** 全局免责与参数版本说明。 */
  readonly notices?: readonly string[];
}

// ── 底座数据的只读视图（结构兼容，不作为类型依赖） ───────────────────
export interface CitationView {
  readonly materialId: string;
  readonly versionId: string;
  readonly textSha256?: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

export interface EntityView {
  readonly name: string;
  readonly kind: 'person' | 'organization' | 'unknown';
  readonly identity?: { readonly scheme: string; readonly value: string } | null;
}

export interface RecordView {
  readonly topic?: string;
  readonly subject?: EntityView | null;
  readonly object?: EntityView | null;
  readonly attributedTo?: EntityView | null;
  readonly event?: { readonly type?: string; readonly key?: string | null; readonly description?: string } | null;
  readonly time?: { readonly raw?: string | null; readonly start?: string | null; readonly end?: string | null; readonly precision?: string } | null;
  readonly value?: { readonly kind?: string; readonly raw?: string | null; readonly normalized?: string | null; readonly unit?: string | null } | null;
  readonly polarity?: string;
  readonly period?: string | null;
  readonly basis?: string | null;
  readonly uncertainty?: readonly string[];
  readonly qualifiers?: Readonly<Record<string, string>>;
}

export interface FindingView {
  readonly id: string;
  readonly needId: string;
  readonly statement: string;
  readonly citations: readonly CitationView[];
  readonly record?: RecordView | null | undefined;
}

/** 底座 coverage 的只读投影；字段缺失时按"未知"处理，绝不当作"已满足"。 */
export interface CoverageView {
  readonly needId: string;
  readonly coverage?: string;
  readonly consistency?: string;
  readonly support?: string;
  readonly satisfaction?: string;
  readonly missingFields?: readonly string[];
  readonly examined?: readonly unknown[];
  readonly unread?: readonly unknown[];
}

export interface SourceRefView {
  readonly materialId: string;
  readonly versionId: string;
  readonly textSha256?: string;
}

/** 一次整理运行的只读视图。底座 LoopRun 结构上满足它。 */
export interface RunView {
  readonly id: string;
  readonly goal: string;
  readonly status: string;
  readonly sources: readonly SourceRefView[];
  readonly findings: readonly FindingView[];
  readonly information?: {
    readonly needs: readonly CoverageView[];
    readonly conflicts?: readonly { readonly findingIds: readonly string[]; readonly classification: string }[];
  } | null | undefined;
  readonly limits?: { readonly maxRounds: number; readonly maxReads: number } | undefined;
}

// ── 判定结果 ─────────────────────────────────────────────────────────
export interface ElementAssessment {
  readonly elementId: string;
  readonly issueId: string;
  readonly title: string;
  readonly state: ElementState;
  /** 通用资料覆盖状态。专业 state 还考虑命题肯否与是否需要评价。 */
  readonly informationState: ElementState;
  /** 已找到可供评价的材料，评价本身仍需人工判断。 */
  readonly evaluationPending?: true;
  /** Explains why records from multiple scopes are not collapsed into one fact. */
  readonly scopeNote?: string;
  readonly claimValues?: readonly string[];
  readonly critical: boolean;
  /** 生效的举证责任（已按转移规则解析）。 */
  readonly burden: Burden;
  /** 知识包声明的基准举证责任。 */
  readonly burdenBase: Burden;
  /** 发生转移时的原因说明。 */
  readonly burdenShiftReason?: string;
  readonly kind: 'factual' | 'evaluative';
  readonly findingIds: readonly string[];
  readonly needIds: readonly string[];
  readonly missingFields: readonly string[];
  readonly missingMaterials: readonly MaterialKind[];
  readonly statute: readonly string[];
  /** 该状态由"需求核对结果"还是"仅按已提取记录"推断而来。 */
  readonly basis: 'analysis' | 'findings';
}

export interface IssueAssessment {
  readonly issueId: string;
  readonly title: string;
  readonly state: IssueState;
  readonly reason: string;
  readonly elementIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly routing: readonly RoutingHint[];
}

export type GapKind = 'conflicting' | 'unread' | 'absent' | 'missing_document' | 'evaluative' | 'negative_fact' | 'missing_period';

export interface Gap {
  readonly elementId: string;
  readonly issueId: string;
  readonly kind: GapKind;
  /** 缺口对谁不利：由 burden + stance 推出来，这是本结构最关键的一格。 */
  readonly consequence: string;
  readonly action: string;
  readonly materials: readonly MaterialKind[];
  readonly sourceIds: readonly string[];
  readonly findingIds: readonly string[];
  /** 补充说明，例如缺失的具体期间。 */
  readonly detail?: string;
}

export interface RouteHit {
  readonly issueId: string;
  readonly title: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

// ── 路径与抗辩的判定结果 ─────────────────────────────────────────────
export const PATH_STATES = ['available', 'needs_check', 'insufficient', 'blocked'] as const;
export type PathState = (typeof PATH_STATES)[number];

export interface PathAssessment {
  readonly pathId: string;
  readonly issueId: string;
  readonly name: string;
  readonly state: PathState;
  /** 已满足的要件 id。 */
  readonly met: readonly string[];
  /** 未满足的要件 id。 */
  readonly missing: readonly string[];
  /** 已成立并阻断本路径的抗辩 id。 */
  readonly blockedBy: readonly string[];
  readonly outcome: string;
  readonly calcPath?: string;
  readonly statute: readonly string[];
  readonly findingIds: readonly string[];
}

export const DEFENSE_STATES = ['unlikely', 'possible', 'grounded'] as const;
export type DefenseState = (typeof DEFENSE_STATES)[number];

export interface DefenseAssessment {
  readonly defenseId: string;
  readonly name: string;
  readonly against: readonly string[];
  readonly state: DefenseState;
  readonly met: readonly string[];
  readonly missing: readonly string[];
  /** 材料中命中的线索词。 */
  readonly signals: readonly string[];
  readonly effect: DefenseEffect;
  readonly response: readonly string[];
  readonly statute: readonly string[];
  readonly findingIds: readonly string[];
}

export interface Assessment {
  readonly knowledgeId: string;
  readonly knowledgeVersion: string;
  readonly stance: Stance;
  readonly runId: string;
  readonly elements: readonly ElementAssessment[];
  readonly issues: readonly IssueAssessment[];
  readonly gaps: readonly Gap[];
  /** 各争点的路径评估；与 issue.state 正交，并列不择一。 */
  readonly paths: readonly PathAssessment[];
  /** 潜在抗辩；只提示可能性与应对材料，不作结论。 */
  readonly defenses: readonly DefenseAssessment[];
  /** 事实因子得分；只作提示，不是法律认定。 */
  readonly factors: readonly FactorAssessment[];
  /** 命中的专业校验提示。 */
  readonly checks: readonly CheckAssessment[];
  readonly route: readonly RouteHit[];
  readonly fallbackIssueId: string;
  /** 数据完整性自检：出现这些值时结论不可作为定论。 */
  readonly warnings: readonly string[];
}
