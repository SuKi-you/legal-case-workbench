/**
 * 通用结构层 · 判定
 *
 * 只做四件事，全部是纯函数：
 *   1) 把底座 coverage / findings 映射成"要件状态"
 *   2) 用规则表把要件状态合成为"争点状态"
 *   3) 生成缺口，并判断"缺了对谁不利"
 *   4) 按已有证据为争点排序（案由路由）
 *
 * 这里没有任何模型调用，也没有任何具体法域名词。
 */
import {
  MATERIAL_KIND_LABEL, elementSeverity, worstState,
  type Assessment, type Burden, type BurdenCondition, type CheckAssessment, type CoverageView,
  type DefenseAssessment, type DefenseState,
  type DomainKnowledge, type ElementAssessment, type ElementExpectation, type ElementSpec, type ElementState,
  type FactorAssessment, type FindingView, type Gap, type GapKind, type IssueAssessment, type IssueSpec, type IssueState,
  type PathAssessment, type PathState, type ProofTask, type RouteHit, type RoutingHint, type RunView, type Stance,
} from './contracts.ts';
import { comparableClaims, periodSeriesKey } from './scope.ts';
import { checkConditionProblems } from './check-conditions.ts';

// ── coverage → 要件状态 ──────────────────────────────────────────────
/**
 * 映射顺序即优先级。关键约定：
 * - not_applicable 是专业结论，优先于一切；
 * - conflicting 优先于 unread/absent：矛盾必须先被人看见；
 * - not_found_in_examined 只能推出 absent（"已核对没找到"），绝不推出"不存在"；
 * - partial 一律降级为 statement_only：字段没齐就不算达到证明要求。
 */
export function stateFromCoverage(coverage: CoverageView): ElementState {
  if (coverage.satisfaction === 'not_applicable') return 'not_applicable';
  if (coverage.consistency === 'conflicting') return 'conflicting';
  if (coverage.coverage === 'unread') return 'unread';
  if (coverage.coverage === 'not_found_in_examined') return 'absent';
  if (coverage.consistency === 'ambiguous' || coverage.satisfaction === 'needs_review' || (coverage.unread?.length ?? 0) > 0 || (coverage.missingFields?.length ?? 0) > 0) return 'needs_review';
  if (coverage.coverage === 'found' && coverage.support === 'document_supported') return 'satisfied';
  if (coverage.coverage === 'found' && coverage.support === 'none') return 'absent';
  if (coverage.coverage === 'found' || coverage.coverage === 'partial') return 'statement_only';
  return 'statement_only';
}

/** 没有 coverage 时的保守推断：有记录=仅陈述，无记录=已核对未找到。 */
function stateFromFindings(findings: readonly FindingView[]): ElementState {
  return findings.length === 0 ? 'unread' : 'statement_only';
}

// ── 举证责任 → 谁吃亏 ────────────────────────────────────────────────
interface PartyText { readonly label: string; readonly adverse: string }

function partyOf(burden: Burden, stance: Stance): PartyText {
  const selfSide = stance === 'claimant' ? 'claimant' : stance === 'respondent' ? 'respondent' : 'neutral';
  switch (burden) {
    case 'claimant':
      return selfSide === 'claimant'
        ? { label: '本方', adverse: '缺材料将由本方承担举证不能的不利后果。' }
        : { label: '对方', adverse: '缺材料时由对方承担举证不能的不利后果，可要求其举证。' };
    case 'respondent':
      return selfSide === 'respondent'
        ? { label: '本方', adverse: '缺材料将由本方承担举证不利后果。' }
        : { label: '对方', adverse: '该材料通常由对方掌握，缺材料时由其承担不利后果，可申请调取。' };
    case 'shared':
      return { label: '双方', adverse: '双方均需就该要件举证，先补本方部分。' };
    case 'authority':
      return { label: '主管机关', adverse: '该要件由主管机关调查认定，不以当事人举证为限。' };
  }
}

// ── 缺口 ─────────────────────────────────────────────────────────────
const materialList = (kinds: readonly string[]): string => kinds
  .map((kind) => MATERIAL_KIND_LABEL[kind as keyof typeof MATERIAL_KIND_LABEL] ?? kind).join('、');

export function gapKindOf(element: ElementSpec, state: ElementState): GapKind | null {
  if (state === 'satisfied' || state === 'not_applicable' || state === 'opposed') return null;
  if (state === 'needs_review') return 'evaluative';
  if (state === 'conflicting') return 'conflicting';
  if (state === 'unread') return 'unread';
  // 消极事实：没有相反记载本身就是有利状态，不是本方举证不能。
  if (state === 'absent') return element.negative === true ? 'negative_fact' : 'absent';
  // 仅有陈述：只有在本要件要求书证、或属评价性要件时才算缺口，否则陈述本就够用。
  if (element.kind === 'evaluative') return 'evaluative';
  if (element.minimumSupport === 'document') return 'missing_document';
  return null;
}

// ── 周期性缺口：缺某个月 ─────────────────────────────────────────────
const PERIOD = /^(\d{4})-(\d{2})$/u;

/** 在已出现的月份范围内找出空月；范围超过 36 个月不做推断，避免误报。 */
export function missingPeriods(periods: readonly string[]): string[] {
  const indexes = periods.flatMap((period) => {
    const match = PERIOD.exec(period.trim());
    const month = match ? Number(match[2]) : 0;
    return match && month >= 1 && month <= 12 ? [Number(match[1]) * 12 + month - 1] : [];
  });
  if (indexes.length < 2) return [];
  const min = Math.min(...indexes);
  const max = Math.max(...indexes);
  if (max - min > 35) return [];
  const have = new Set(indexes);
  const missing: string[] = [];
  for (let index = min; index <= max; index += 1) {
    if (!have.has(index)) missing.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
  }
  return missing;
}

function describeGap(element: ElementSpec, state: ElementState, kind: GapKind, stance: Stance, burden: Burden): { consequence: string; action: string } {
  const party = partyOf(burden, stance);
  switch (kind) {
    case 'conflicting':
      return {
        consequence: '同一事项存在相互矛盾的记载，不能自动择一，须人工核对后确定采用哪一条。',
        action: '调取原始材料比对，必要时向当事人核实后确定。',
      };
    case 'unread':
      return {
        consequence: `选定材料尚未读取，本要件不能判定。"未读取"不等于"不存在"，不能据此作否定结论。`,
        action: `先读取剩余材料，再判断本要件；可补材料类型：${materialList(element.materials)}。`,
      };
    case 'evaluative':
      return {
        consequence: '属评价性要件，需结合多项事实综合判断，不得由单一记载直接认定。',
        action: `先补齐可支撑综合判断的事实与材料：${materialList(element.materials)}。`,
      };
    case 'missing_document':
      return {
        consequence: `现仅有陈述，未达本要件的书证要求。${party.label}${party.label === '本方' ? '需补强' : '应提供'}书证；${party.adverse}`,
        action: `补强书证：${materialList(element.materials.filter((item) => item !== 'statement'))}。`,
      };
    case 'negative_fact':
      return {
        consequence: '属消极事实：材料中没有相反记载时，应由主张该事实存在的对方举证；缺材料不构成本方举证不能。',
        action: '确认对方能否提供相反证据（如已订立的书面文件）；必要时请求其举证，无需重复向当事人索取。',
      };
    case 'missing_period':
      return {
        consequence: '在已出现的期间范围内存在没有记录的月份；"缺记录"不等于"未支付"。',
        action: '补取缺失期间的凭证；如由单位发放，可要求其提供支付记录。',
      };
    case 'absent':
      return {
        consequence: `${party.label}承担本要件举证责任。${party.adverse}`,
        action: `补充材料：${materialList(element.materials)}。`,
      };
  }
}

// ── 要件 ─────────────────────────────────────────────────────────────
function assessElement(
  element: ElementSpec,
  coverageByNeed: ReadonlyMap<string, CoverageView>,
  findingsByNeed: ReadonlyMap<string, readonly FindingView[]>,
  conflicts: NonNullable<NonNullable<RunView['information']>['conflicts']> = [],
): ElementAssessment {
  const coverage = element.needs.map((need) => coverageByNeed.get(need)).filter((item): item is CoverageView => item !== undefined);
  const findings = element.needs.flatMap((need) => findingsByNeed.get(need) ?? []);

  const fromAnalysis = coverage.length === element.needs.length;
  const informationState: ElementState = coverage.length > 0
    ? worstState(element.needs.map((need) => coverageByNeed.has(need) ? stateFromCoverage(coverageByNeed.get(need)!) : 'unread'))
    : stateFromFindings(findings);
  let state = informationState;
  let scopeNote: string | undefined;
  // A negative answer is useful information, but cannot satisfy a positive proposition.
  if (element.expectedPolarity && findings.length > 0 && state !== 'not_applicable') {
    const polarityOf = (finding: FindingView) => {
      const record = finding.record;
      if (!record || record.polarity === 'uncertain') return record?.polarity;
      // Boolean normalization denotes the positive proposition itself; do not negate it twice.
      if (record.value?.kind === 'boolean' && record.value.normalized === 'false') return 'denied';
      return record.polarity;
    };
    const polarities = new Set(findings.map(polarityOf));
    if (polarities.has('affirmed') && polarities.has('denied')) {
      const positive = findings.filter((finding) => polarityOf(finding) === 'affirmed');
      const negative = findings.filter((finding) => polarityOf(finding) === 'denied');
      const comparableOpposition = positive.some((a) => negative.some((b) => comparableClaims(a, b, conflicts) === true));
      if (comparableOpposition) state = 'conflicting';
      else {
        if (!['unread', 'absent'].includes(informationState)) state = 'needs_review';
        scopeNote = '同一需求下含不同参与者、事件、期间或比较条件的相反记录；尚不能合并成同一命题的冲突，应先明确本次检查范围。';
      }
    }
    else if (['satisfied', 'statement_only'].includes(informationState)) {
      if (polarities.has('uncertain') || polarities.has(undefined)) state = 'needs_review';
      else if (!polarities.has(element.expectedPolarity)) state = 'opposed';
    }
  }

  const missingFields = [...new Set(coverage.flatMap((item) => item.missingFields ?? []))];
  const evaluationPending = element.kind === 'evaluative' && (state === 'satisfied' || state === 'statement_only');

  return {
    elementId: element.id,
    issueId: element.issueId,
    title: element.title,
    state: evaluationPending ? 'needs_review' : state,
    informationState,
    ...(evaluationPending ? { evaluationPending: true as const } : {}),
    ...(scopeNote === undefined ? {} : { scopeNote }),
    claimValues: findings.filter((finding) => finding.record?.polarity === 'affirmed').flatMap((finding) => finding.record?.value?.normalized ? [finding.record.value.normalized] : []),
    critical: element.critical,
    burden: element.burden,
    burdenBase: element.burden,
    kind: element.kind,
    findingIds: [...new Set(findings.map((finding) => finding.id))],
    needIds: [...element.needs],
    missingFields,
    missingMaterials: state === 'satisfied' || state === 'not_applicable' ? [] : [...element.materials],
    statute: [...(element.statute ?? [])],
    basis: fromAnalysis ? 'analysis' : 'findings',
  };
}

// ── 争点 ─────────────────────────────────────────────────────────────
function assessIssue(issue: IssueSpec, states: ReadonlyMap<string, ElementState>, elements: readonly ElementSpec[]): { state: IssueState; reason: string } {
  const own = issue.elements.map((id) => states.get(id)).filter((state): state is ElementState => state !== undefined);
  // 全部专业上不适用：不生成缺口，也不判材料不足。
  if (own.length > 0 && own.every((state) => state === 'not_applicable')) {
    return { state: 'not_applicable', reason: '本争点下的要件均被专业声明为不适用。' };
  }
  for (const rule of issue.rules) {
    const matched = rule.all.every((expectation) => {
      const state = states.get(expectation.elementId);
      return state !== undefined && expectation.in.includes(state);
    });
    if (matched) {
      if (rule.then === 'judgeable') {
        const blocked = elements.filter((element) => element.critical && !['satisfied', 'statement_only', 'not_applicable'].includes(states.get(element.id) ?? 'unread'));
        if (blocked.length > 0) return { state: blocked.some((element) => states.get(element.id) === 'conflicting') ? 'disputed' : 'insufficient', reason: `核心信息仍需核对：${blocked.map((element) => element.title).join('、')}。` };
      }
      return { state: rule.then, reason: rule.reason };
    }
  }
  const critical = elements.filter((element) => element.critical).map((element) => element.title);
  return { state: 'insufficient', reason: `未命中任何判定规则；核心要件（${critical.join('、') || '无'}）尚不足以支撑判断。` };
}

// ── 程序分流 ─────────────────────────────────────────────────────────
/**
 * 只把"本案材料里确实出现"的分流提示带出来。
 * 分流不是判定，不参与要件状态，只提示先走别的程序。
 */
export function activeRouting(issue: IssueSpec, text: string): RoutingHint[] {
  const lower = text.toLowerCase();
  return (issue.routing ?? []).filter((hint) => hint.when.length === 0
    || hint.when.some((keyword) => lower.includes(keyword.toLowerCase())));
}

// ── 案由路由 ─────────────────────────────────────────────────────────
export function routeIssues(knowledge: DomainKnowledge, run: RunView): RouteHit[] {
  const text = [run.goal, ...run.findings.map((finding) => finding.statement)].join('\n').toLowerCase();
  const findingsByNeed = indexByNeed(run.findings);

  const hits: RouteHit[] = knowledge.issues.map((issue) => {
    const reasons: string[] = [];
    let score = 0;
    for (const elementId of issue.elements) {
      const element = knowledge.elements.find((item) => item.id === elementId);
      if (!element) continue;
      const count = element.needs.reduce((total, need) => total + (findingsByNeed.get(need)?.length ?? 0), 0);
      if (count > 0) {
        const weight = element.critical ? 3 : 1;
        score += weight * Math.min(count, 2);
        reasons.push(`已提取到「${element.title}」相关记载 ${count} 条`);
      }
    }
    for (const rule of knowledge.routing ?? []) {
      if (rule.issueId !== issue.id) continue;
      const matched = rule.keywords.filter((keyword) => text.includes(keyword.toLowerCase()));
      if (matched.length > 0) {
        score += 2 * matched.length;
        reasons.push(`表述命中关键词：${matched.join('、')}`);
      }
    }
    return { issueId: issue.id, title: issue.title, score, reasons };
  });

  return hits.filter((hit) => hit.score > 0).sort((left, right) => right.score - left.score || left.issueId.localeCompare(right.issueId));
}

// ── 路径与抗辩 ───────────────────────────────────────────────────────
/** 一条期望是否被当前状态满足。 */
const holds = (states: ReadonlyMap<string, ElementState>, expectation: ElementExpectation): boolean => {
  const state = states.get(expectation.elementId);
  return state !== undefined && expectation.in.includes(state);
};

/** 这两类状态表示"事实还没有"，而不是"事实不支持"。 */
const NOT_YET: readonly ElementState[] = ['absent', 'unread'];

/**
 * 路径评估：并列输出，不排序、不推荐。
 * - blocked：被"事实已齐备"的抗辩阻断（不等于抗辩一定成立，仍需人工应对）
 * - available：所有成立条件都满足
 * - insufficient：缺的要件属于"还没读到/没有记载"
 * - needs_check：只差"仅有陈述"这类中间态，需人工核实
 */
export function assessPaths(
  issue: IssueSpec,
  states: ReadonlyMap<string, ElementState>,
  defenses: readonly DefenseAssessment[],
  elements: ReadonlyMap<string, ElementAssessment>,
): PathAssessment[] {
  const grounded = new Set(defenses.filter((item) => item.state === 'grounded').map((item) => item.defenseId));
  return (issue.paths ?? []).map((path) => {
    const met = path.requires.filter((expectation) => holds(states, expectation)).map((expectation) => expectation.elementId);
    const missing = path.requires.filter((expectation) => !holds(states, expectation)).map((expectation) => expectation.elementId);
    const blockedBy = (path.blockedBy ?? []).filter((id) => grounded.has(id));
    const missingNotYet = missing.filter((id) => NOT_YET.includes(states.get(id) ?? 'absent'));

    const state: PathState = blockedBy.length > 0 ? 'blocked'
      : missing.length === 0 ? 'available'
        : missingNotYet.length > 0 ? 'insufficient'
          : 'needs_check';

    return {
      pathId: path.id,
      issueId: issue.id,
      name: path.name,
      state,
      met,
      missing,
      blockedBy,
      outcome: path.outcome,
      ...(path.calcPath === undefined ? {} : { calcPath: path.calcPath }),
      statute: [...path.statute],
      findingIds: [...new Set(path.requires.flatMap((expectation) => elements.get(expectation.elementId)?.findingIds ?? []))],
    };
  });
}

/**
 * 抗辩评估：只给"可能性"，不给概率。
 * grounded = 该抗辩需要的事实都已具备，需重点应对；不等于抗辩一定成立。
 * signals 命中时把"没有迹象"提升为 possible，用于发现书面协议、违纪记载这类线索。
 */
export function assessDefenses(
  knowledge: DomainKnowledge,
  states: ReadonlyMap<string, ElementState>,
  text: string,
  elements: ReadonlyMap<string, ElementAssessment>,
): DefenseAssessment[] {
  return (knowledge.defenses ?? []).map((defense) => {
    const met = defense.requires.filter((expectation) => holds(states, expectation)).map((expectation) => expectation.elementId);
    const missing = defense.requires.filter((expectation) => !holds(states, expectation)).map((expectation) => expectation.elementId);
    const lower = text.toLowerCase();
    let signals = (defense.signals ?? []).filter((signal) => lower.includes(signal.toLowerCase()));

    const claim = defense.claim;
    const matchingClaim = claim === undefined || [...elements.values()].some((element) => element.needIds.includes(claim.needId)
      && element.state !== 'opposed' && element.state !== 'conflicting' && element.state !== 'needs_review'
      && element.claimValues?.some((value) => claim.values.includes(value)));
    const hasClaimValue = claim !== undefined && [...elements.values()].some((element) => element.needIds.includes(claim.needId) && (element.claimValues?.length ?? 0) > 0);
    if (hasClaimValue && !matchingClaim) signals = [];
    const qualified = defense.requires.length > 0 && met.length === defense.requires.length && matchingClaim
      && (defense.requiresSignal !== true || signals.length > 0 || (claim !== undefined && matchingClaim));
    const state: DefenseState = qualified && defense.reviewRequired !== true ? 'grounded'
      : (qualified || signals.length > 0) && (claim === undefined || matchingClaim || signals.length > 0) ? 'possible' : 'unlikely';

    return {
      defenseId: defense.id,
      name: defense.name,
      against: [...defense.against],
      state,
      met,
      missing,
      signals,
      effect: defense.effect,
      response: [...defense.response],
      statute: [...defense.statute],
      findingIds: [...new Set(defense.requires.flatMap((expectation) => elements.get(expectation.elementId)?.findingIds ?? []))],
    };
  });
}

// ── 事实因子 ─────────────────────────────────────────────────────────
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * 加权聚合：satisfied 计满、statement_only 计半、其余计 0，再除以总权重。
 * 分档从高到低匹配；没有命中任何档时取最后一档（通常是"弱"）。
 */
export function assessFactors(
  knowledge: DomainKnowledge,
  states: ReadonlyMap<string, ElementState>,
): FactorAssessment[] {
  return (knowledge.factors ?? []).map((factor) => {
    const totalWeight = factor.parts.reduce((sum, part) => sum + part.weight, 0);
    const contributions = factor.parts.map((part) => {
      const state = states.get(part.elementId) ?? 'absent';
      const ratio = state === 'satisfied' ? 1 : state === 'statement_only' ? 0.5 : 0;
      return { elementId: part.elementId, state, weight: part.weight, points: round2(part.weight * ratio) };
    });
    const earned = contributions.reduce((sum, item) => sum + item.points, 0);
    const score = totalWeight > 0 ? round2(earned / totalWeight) : 0;
    const sorted = [...factor.bands].sort((left, right) => right.min - left.min);
    const band = sorted.find((item) => score >= item.min) ?? sorted.at(-1);
    return {
      factorId: factor.id,
      title: factor.title,
      issueId: factor.issueId,
      score,
      band: band?.label ?? '未分档',
      bandNote: band?.note ?? '',
      contributions,
      note: factor.note,
    };
  });
}

// ── 专业校验 ─────────────────────────────────────────────────────────
/** 命中即提示：只看事实组合，不产出结论。 */
export function assessChecks(
  knowledge: DomainKnowledge,
  states: ReadonlyMap<string, ElementState>,
  text: string,
  context: { readonly elements: readonly ElementAssessment[]; readonly gaps: readonly Gap[] } = { elements: [], gaps: [] },
): CheckAssessment[] {
  return (knowledge.checks ?? [])
    .filter((check) => checkConditionProblems(check, knowledge.elements).length === 0
      && check.when.every((condition) => conditionHolds(condition, states, text)))
    .filter((check) => check.claim === undefined || context.elements.some((element) => element.needIds.includes(check.claim!.needId)
      && element.claimValues?.some((value) => check.claim!.values.includes(value))))
    .filter((check) => check.gap === undefined || context.gaps.some((gap) => gap.elementId === check.gap!.elementId && gap.kind === check.gap!.kind))
    .map((check) => ({
      checkId: check.id,
      title: check.title,
      severity: check.severity,
      message: check.message,
      statute: [...check.statute],
    }));
}

// ── 证明任务 ─────────────────────────────────────────────────────────
/**
 * 由缺口派生"要证明什么、用什么、达到什么标准"。
 * 直接对应承办人的动作：补哪份材料、问到什么程度算够。
 */
export function buildProofTasks(knowledge: DomainKnowledge, assessment: Assessment): ProofTask[] {
  const counts = new Map<string, number>();
  for (const gap of assessment.gaps) counts.set(gap.elementId, (counts.get(gap.elementId) ?? 0) + 1);
  const ordinals = new Map<string, number>();
  return assessment.gaps.map((gap) => {
    const ordinal = (ordinals.get(gap.elementId) ?? 0) + 1;
    ordinals.set(gap.elementId, ordinal);
    const element = knowledge.elements.find((item) => item.id === gap.elementId);
    const title = element?.title ?? gap.elementId;
    const goal = (() => {
      switch (gap.kind) {
        case 'missing_period': return `补取 ${gap.detail?.replace('缺失期间：', '') ?? '缺失期间'} 的凭证，确认是否存在该期间的记载`;
        case 'missing_document': return `为「${title}」补充书证，现有材料仅有陈述`;
        case 'unread': return `先读取剩余材料，确认是否存在「${title}」的记载`;
        case 'conflicting': return `核对「${title}」的矛盾记载，确定采用哪一条`;
        case 'negative_fact': return `确认对方能否就「${title}」提供相反证据`;
        case 'evaluative': return `就「${title}」补充多项事实后综合判断`;
        case 'absent': return `补取可证明「${title}」的材料`;
      }
    })();
    return {
      id: `${gap.elementId}#proof${counts.get(gap.elementId)! > 1 ? `:${gap.kind}:${ordinal}` : ''}`,
      elementId: gap.elementId,
      issueId: gap.issueId,
      goal,
      materials: [...gap.materials],
      standard: element?.minimumSupport ?? 'statement',
      burden: assessment.elements.find((item) => item.elementId === gap.elementId)?.burden ?? 'shared',
      basis: gap.consequence,
      gapKind: gap.kind,
    };
  });
}

// ── 主入口 ───────────────────────────────────────────────────────────
function indexByNeed(findings: readonly FindingView[]): Map<string, FindingView[]> {
  const map = new Map<string, FindingView[]>();
  for (const finding of findings) {
    const list = map.get(finding.needId);
    if (list) list.push(finding); else map.set(finding.needId, [finding]);
  }
  return map;
}

// ── 举证责任转移 ─────────────────────────────────────────────────────
/** 单个条件是否成立：要件条件与线索词条件是合取关系。 */
export function conditionHolds(
  condition: BurdenCondition,
  states: ReadonlyMap<string, ElementState>,
  text: string,
): boolean {
  if (condition.elementId !== undefined) {
    const state = states.get(condition.elementId);
    if (state === undefined || condition.in === undefined || !condition.in.includes(state)) return false;
  }
  if (condition.signal !== undefined && !text.toLowerCase().includes(condition.signal.toLowerCase())) return false;
  return true;
}

/**
 * 生效的举证责任：基准 → 首个命中的转移规则。
 * 转移不改变要件状态，只改变"缺口对谁不利"的说法，以及抗辩/路径的举证方向。
 */
export function resolveBurden(
  spec: ElementSpec | undefined,
  states: ReadonlyMap<string, ElementState>,
  text: string,
): { burden: Burden; reason?: string } {
  if (!spec) return { burden: 'shared' };
  for (const shift of spec.burdenShift ?? []) {
    if (shift.when.length > 0 && shift.when.every((condition) => conditionHolds(condition, states, text))) {
      return { burden: shift.then, reason: shift.reason };
    }
  }
  return { burden: spec.burden };
}

export function assessRun(knowledge: DomainKnowledge, run: RunView): Assessment {
  const coverageByNeed = new Map<string, CoverageView>((run.information?.needs ?? []).map((item) => [item.needId, item]));
  const findingsByNeed = indexByNeed(run.findings);
  const runText = run.findings.filter((finding) => finding.record?.polarity !== 'denied').map((finding) => finding.statement).join('\n');

  // 第一遍：算出要件状态；第二遍再按状态与材料文本判定举证责任是否转移（避免循环依赖）。
  const baseElements = knowledge.elements.map((element) => assessElement(element, coverageByNeed, findingsByNeed, run.information?.conflicts));
  const states = new Map(baseElements.map((element) => [element.elementId, element.state]));
  const effectiveBurdenByElement = new Map<string, { burden: Burden; reason?: string }>();
  const elements = baseElements.map((element) => {
    const spec = knowledge.elements.find((item) => item.id === element.elementId);
    const resolved = resolveBurden(spec, states, runText);
    effectiveBurdenByElement.set(element.elementId, resolved);
    return {
      ...element,
      burden: resolved.burden,
      burdenBase: spec?.burden ?? element.burden,
      ...(resolved.reason === undefined ? {} : { burdenShiftReason: resolved.reason }),
    } satisfies ElementAssessment;
  });

  const issues: IssueAssessment[] = knowledge.issues.map((issue) => {
    const { state, reason } = assessIssue(issue, states, knowledge.elements.filter((element) => issue.elements.includes(element.id)));
    const findingIds = [...new Set(elements.filter((element) => issue.elements.includes(element.elementId)).flatMap((element) => element.findingIds))];
    return {
      issueId: issue.id,
      title: issue.title,
      state,
      reason,
      elementIds: [...issue.elements],
      findingIds,
      routing: activeRouting(issue, runText),
    };
  });

  // 抗辩先算，路径的 blockedBy 依赖它；两者都不改变 issue.state。
  const elementMap = new Map(elements.map((element) => [element.elementId, element]));
  const defenses = assessDefenses(knowledge, states, runText, elementMap);
  const paths = knowledge.issues.flatMap((issue) => assessPaths(issue, states, defenses, elementMap));
  const factors = assessFactors(knowledge, states);

  const gaps: Gap[] = elements.flatMap((element) => {
    const spec = knowledge.elements.find((item) => item.id === element.elementId);
    if (!spec) return [];
    const collected: Gap[] = [];

    const kind = gapKindOf(spec, element.state);
    if (kind) {
      const { consequence, action } = describeGap(spec, element.state, kind, knowledge.stance, element.burden);
      collected.push({
        elementId: element.elementId,
        issueId: element.issueId,
        kind,
        consequence,
        action,
        materials: [...spec.materials],
        sourceIds: [...(spec.statute ?? [])],
        findingIds: [...element.findingIds],
      });
    }

    // 周期性要件：在已出现范围内逐月比对，空月单独成一条缺口。
    if (spec.periodic === true) {
      const series = new Map<string, FindingView[]>();
      for (const finding of spec.needs.flatMap((need) => findingsByNeed.get(need) ?? [])) {
        const key = periodSeriesKey(finding);
        series.set(key, [...(series.get(key) ?? []), finding]);
      }
      for (const records of series.values()) {
        const periods = records.map((finding) => finding.record?.period?.trim())
          .filter((period): period is string => Boolean(period));
        const missing = missingPeriods(periods);
        if (missing.length === 0) continue;
        const participants = [records[0]?.record?.subject?.name, records[0]?.record?.object?.name].filter(Boolean).join(' → ');
        const party = partyOf(effectiveBurdenByElement.get(element.elementId)?.burden ?? spec.burden, knowledge.stance);
        collected.push({
          elementId: element.elementId,
          issueId: element.issueId,
          kind: 'missing_period',
          consequence: `${participants ? `「${participants}」记录序列中，` : ''}${missing.join('、')} 没有对应的支付记载。${party.adverse}注意：仅在同一参与对象、口径及已出现期间范围内推断，"缺记录"不等于"未支付"。`,
          action: `补取上述期间的凭证；如凭证由对方掌握，可要求其提供。`,
          materials: [...spec.materials],
          sourceIds: [...(spec.statute ?? [])],
          findingIds: records.map((record) => record.id),
          detail: `缺失期间：${missing.join('、')}`,
        });
      }
    }

    return collected;
  });
  const checks = assessChecks(knowledge, states, runText, { elements, gaps });

  const warnings: string[] = [];
  if (!run.information) warnings.push('本次运行没有需求核对结果，要件状态仅按已提取记录推断，不能作为定论。');
  else if (elements.some((element) => element.basis === 'findings')) warnings.push('部分要件缺少需求核对结果，已按已提取记录保守推断。');
  if (run.status !== 'completed') warnings.push(`本次整理状态为「${run.status}」，结论需先补齐读取或复核。`);
  const shakySources = Object.values(knowledge.sources).filter((source) => source.validity === 'unverified' || source.authorityLevel === 'model');
  if (shakySources.length > 0) warnings.push(`有 ${shakySources.length} 条法源标记为待验证（${shakySources.map((source) => source.id).join('、')}），引用前须核对现行文本。`);
  if (elements.some((element) => element.kind === 'evaluative' && element.critical)) warnings.push('存在被设为核心要件的评价性要件，可能导致争点永远无法判定，请检查知识包。');
  if (defenses.some((defense) => defense.state !== 'unlikely')) warnings.push('候选抗辩仍需核对主张、事实和法律适用；候选线索本身不排除请求路径。');
  if (paths.length > 1 && paths.every((path) => path.state !== 'available')) warnings.push('多条路径均缺要件，当前不能确定走哪一条；请先补齐缺口。');

  return {
    knowledgeId: knowledge.id,
    knowledgeVersion: knowledge.version,
    stance: knowledge.stance,
    runId: run.id,
    elements,
    issues,
    gaps: gaps.sort((left, right) => elementSeverity(states.get(right.elementId) ?? 'satisfied') - elementSeverity(states.get(left.elementId) ?? 'satisfied')),
    paths,
    defenses,
    factors,
    checks,
    route: routeIssues(knowledge, run),
    fallbackIssueId: knowledge.fallbackIssueId,
    warnings,
  };
}
