/**
 * 劳动法插件 · 工具
 *
 * 为什么缺口放在工具里而不是成果区块：
 * 底座 OutputSection 要求每一段、每一行都引用至少一条本运行内的 finding，
 * 而"完全没有材料"的缺口恰恰没有 finding 可引。工具输出不受这个约束，
 * 因此清单、缺口、测算都通过工具交给模型，再由它在回复中转述。
 *
 * 全部为只读工具（effect: 'read'），不产生案件写入，因此不需要 reconcile。
 */
import { resolve } from 'node:path';
import { AgentToolError, defineAgentTool, type AgentTool, type AgentToolContext, type LoopRun, type StructuredNeed, LoopRunStore } from './base.ts';
import { assessRun, buildProofTasks } from './kernel/assess.ts';
import { evaluateOpinions, OpinionError, type OpinionModel } from './kernel/opinion.ts';
import { ELEMENT_LABEL, ISSUE_LABEL } from './kernel/sections.ts';
import { objectInput, type ObjectInput } from './kernel/schema.ts';
import {
  MATERIAL_KIND_LABEL,
  type Assessment, type DomainKnowledge, type MaterialKind, type Stance,
} from './kernel/contracts.ts';
import {
  PLACEHOLDER_PARAMS, arbitrationLimitation, doubleWage, illegalTerminationDamages,
  noticePay, overtimePay, segmentedSeverance, severance, type CalcTrace, type LaborParams,
} from './labor/calc.ts';

// ── 数据目录解析 ─────────────────────────────────────────────────────
/**
 * 当前底座没有把 dataDir 放进 AgentToolContext，插件只能自行解析。
 * 优先级：环境变量 LAW_AGENT_DATA_DIR → 进程工作目录下的 runtime-data（与 CLI 默认值一致）。
 * 这是底座接口的一处已知限制，接入 Web 层时应改为由上下文注入。
 */
export function resolveDataDir(): string {
  const fromEnv = process.env.LAW_AGENT_DATA_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(process.cwd(), 'runtime-data');
}

export interface LaborToolOptions {
  readonly knowledge: DomainKnowledge;
  /** 与 profile 中一致的信息需求，checklist 的 needs 明细会用它们。 */
  readonly needs?: readonly StructuredNeed[];
  readonly params?: LaborParams;
  readonly dataDir?: () => string;
  /** 允许测试注入自己的运行读取器，避免依赖文件系统。 */
  readonly loadRun?: (caseId: string, runId: string) => Promise<LoopRun>;
  /**
   * 评价性要件的模型句柄。省略时 labor.opinions 返回"未启用"而不是报错。
   * 这是插件里唯一会调用模型的地方，一次评估只调用一次。
   */
  readonly model?: OpinionModel;
}

type StanceOverride = { stance?: Stance };

function knowledgeFor(base: DomainKnowledge, stance?: Stance): DomainKnowledge {
  return stance === undefined || stance === base.stance ? base : { ...base, stance };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function assertUuid(value: string, field: string): string {
  if (!UUID.test(value)) throw new AgentToolError('LABOR_INPUT_INVALID', `${field} 必须是案件内的运行/对象 ID（UUID）。`);
  return value;
}

const stanceField = { type: 'string' as const, description: '视角：claimant（劳动者方）／respondent（用工方）／neutral。默认沿用插件配置。', enum: ['claimant', 'respondent', 'neutral'], optional: true as const };

// ── checklist ────────────────────────────────────────────────────────
type ChecklistInput = { issueId?: string; include?: 'summary' | 'elements' | 'needs' };
const checklistInput: ObjectInput<ChecklistInput> = objectInput<ChecklistInput>({
  issueId: { type: 'string', description: '只查看某个争点（留空则列出全部）。', optional: true },
  include: { type: 'string', description: '输出详细程度：summary（默认，仅争点）／elements（含要件）／needs（含信息需求）。', enum: ['summary', 'elements', 'needs'], optional: true },
});

// ── assess / gaps ────────────────────────────────────────────────────
type RunInput = { runId: string } & StanceOverride;
const runInput: ObjectInput<RunInput> = objectInput<RunInput>({
  runId: { type: 'string', description: '整理运行 ID（information.runs 返回的 runId）。' },
  stance: stanceField,
});

// ── opinions（唯一会调用模型的工具） ─────────────────────────────────
type OpinionInput = RunInput & { elementId?: string };
const opinionInput: ObjectInput<OpinionInput> = objectInput<OpinionInput>({
  runId: { type: 'string', description: '整理运行 ID（information.runs 返回的 runId）。' },
  stance: stanceField,
  elementId: { type: 'string', description: '只评估某一个评价性要件；省略则评估全部。', optional: true },
});

// ── amount ───────────────────────────────────────────────────────────
type AmountPath = 'severance' | 'severance-segmented' | 'illegal-termination' | 'notice-pay' | 'double-wage' | 'overtime';
type AmountInput = {
  path: AmountPath;
  monthlyWage: number;
  totalMonths?: number;
  partialWorkDays?: number;
  dailyWage?: number;
  unsignedMonths?: number;
  startDate?: string;
  endDate?: string;
  weekdayHours?: number;
  restDayHours?: number;
  holidayHours?: number;
};
const amountInput: ObjectInput<AmountInput> = objectInput<AmountInput>({
  path: {
    type: 'string',
    description: '测算路径：severance（经济补偿）／severance-segmented（跨 2008 年的分段经济补偿）／illegal-termination（违法解除赔偿金）／notice-pay（代通知金）／double-wage（二倍工资）／overtime（加班费）。同一案件的多条路径应分别测算，本工具不自动择一。',
    enum: ['severance', 'severance-segmented', 'illegal-termination', 'notice-pay', 'double-wage', 'overtime'],
  },
  monthlyWage: { type: 'number', description: '月工资（元）；notice-pay必须传上一个月工资，经济补偿则为前十二个月平均工资。', minimum: 0 },
  totalMonths: { type: 'number', description: '工作年限月数，必须保留不足整月的正小数零头；优先使用起止日期（用于补偿/赔偿金）。', minimum: 0, optional: true },
  partialWorkDays: { type: 'number', description: '二倍工资不足整月部分的实际工作日；与dailyWage同时提供。', minimum: 0, maximum: 31, optional: true },
  dailyWage: { type: 'number', description: '按适用工资口径经确认的日工资；不由模型猜测。', minimum: 0, optional: true },
  unsignedMonths: { type: 'number', description: '未订立书面合同的月数（用于二倍工资）。', minimum: 0, optional: true },
  startDate: { type: 'string', description: '入职日 YYYY-MM-DD（用于分段经济补偿）。', optional: true },
  endDate: { type: 'string', description: '解除或终止日 YYYY-MM-DD（用于分段经济补偿）。', optional: true },
  weekdayHours: { type: 'number', description: '工作日加班小时数。', minimum: 0, optional: true },
  restDayHours: { type: 'number', description: '休息日加班小时数。', minimum: 0, optional: true },
  holidayHours: { type: 'number', description: '法定节假日加班小时数。', minimum: 0, optional: true },
});

// ── deadline ─────────────────────────────────────────────────────────
type DeadlineInput = {
  from: string;
  today: string;
  kind: 'wage' | 'other' | 'double-wage';
  relationOngoing: boolean;
  interruptions?: string;
  localCaliberConfirmed?: boolean;
};
const deadlineInput: ObjectInput<DeadlineInput> = objectInput<DeadlineInput>({
  from: { type: 'string', description: '起算日 YYYY-MM-DD（知道或应当知道权利被侵害之日；拖欠报酬已终止的，为终止之日）。' },
  today: { type: 'string', description: '基准日 YYYY-MM-DD（通常为今天）。' },
  kind: { type: 'string', description: '争议类型：wage（拖欠劳动报酬）／other（其他）／double-wage（二倍工资）。', enum: ['wage', 'other', 'double-wage'] },
  relationOngoing: { type: 'boolean', description: '劳动关系是否仍然存续（仅影响拖欠劳动报酬的时效）。' },
  interruptions: { type: 'string', description: '中断事由日期，多个用逗号分隔（主张权利、对方同意履行、申请调解等）。取最晚一次重新起算。', optional: true },
  localCaliberConfirmed: { type: 'boolean', description: '二倍工资时效起算口径是否已按本地区确认（未确认时不作为结论）。', optional: true },
});

// ── 输出整形 ─────────────────────────────────────────────────────────
const materialLabels = (kinds: readonly MaterialKind[]): string[] => kinds.map((kind) => MATERIAL_KIND_LABEL[kind]);

function trace(result: CalcTrace): Record<string, unknown> {
  return {
    formula: result.formula, inputs: result.inputs,
    assumptions: result.assumptions, sources: result.sources,
    verified: result.verified, parametersVerified: result.parametersVerified ?? result.verified, applicabilityVerified: false, formulaVersion: result.formulaVersion ?? 'labor-calc-2', calculationStatus: result.calculationStatus ?? 'computed',
    applicability: '需由承办人确认计算路径与工资口径，参数核验不等于法律适用已确认',
    note: result.verified ? '参数已核验。' : '参数未核验：结果仅为测算草稿，不得作为结论或对外文书依据。',
  };
}

function assessSummary(assessment: Assessment): Record<string, unknown> {
  return {
    runId: assessment.runId,
    knowledge: { id: assessment.knowledgeId, version: assessment.knowledgeVersion },
    stance: assessment.stance,
    issues: assessment.issues.map((issue) => ({
      issueId: issue.issueId, title: issue.title, state: issue.state, stateLabel: ISSUE_LABEL[issue.state],
      reason: issue.reason, evidenceCount: issue.findingIds.length,
      routing: issue.routing.map((hint) => ({ id: hint.id, action: hint.action })),
    })),
    elements: assessment.elements.map((element) => ({
      elementId: element.elementId, title: element.title, state: element.state, stateLabel: ELEMENT_LABEL[element.state],
      basis: element.basis, burden: element.burden, evidenceCount: element.findingIds.length,
      missingFields: element.missingFields,
      ...(element.burden === element.burdenBase ? {} : {
        burdenBase: element.burdenBase,
        ...(element.burdenShiftReason === undefined ? {} : { burdenShiftReason: element.burdenShiftReason }),
      }),
    })),
    gapCount: assessment.gaps.length,
    pathCount: assessment.paths.length,
    defenseCount: assessment.defenses.length,
    factors: assessment.factors.map((factor) => ({
      factorId: factor.factorId, title: factor.title, score: factor.score,
      band: factor.band, bandNote: factor.bandNote, note: factor.note,
      contributions: factor.contributions,
    })),
    checks: assessment.checks,
    warnings: assessment.warnings,
    reminder: '本结果说明"事实够不够判断"，不是法律结论；要件是否成立由承办人判断。',
  };
}

const PATH_LABEL: Readonly<Record<string, string>> = Object.freeze({
  available: '要件齐备', needs_check: '需核实', insufficient: '缺要件', blocked: '被抗辩阻断',
});
const TENDENCY_LABEL: Readonly<Record<string, string>> = Object.freeze({
  likely: '倾向站得住', unlikely: '倾向站不住', unclear: '无法判断',
});
const CONFIDENCE_LABEL: Readonly<Record<string, string>> = Object.freeze({ low: '把握低', medium: '把握中', high: '把握高' });
const DEFENSE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  unlikely: '可能性低', possible: '可能命中', grounded: '事实已齐备',
});

// ── 工具实现 ─────────────────────────────────────────────────────────
export function createLaborTools(options: LaborToolOptions): AgentTool[] {
  const params = options.params ?? PLACEHOLDER_PARAMS;
  const dataDir = options.dataDir ?? resolveDataDir;
  const load = async (context: AgentToolContext, runId: string): Promise<LoopRun> => {
    if (context.services) return context.services.runs.read(runId);
    const caseId = context.caseId;
    if (options.loadRun) return options.loadRun(caseId, runId);
    return new LoopRunStore(dataDir()).read({ caseId, runId });
  };

  const checklist = (input: ChecklistInput, knowledge: DomainKnowledge): Record<string, unknown> => {
    const issues = knowledge.issues.filter((issue) => input.issueId === undefined || issue.id === input.issueId);
    if (issues.length === 0) throw new AgentToolError('LABOR_INPUT_INVALID', `没有这个争点：${input.issueId ?? ''}`);
    const detail = input.include ?? 'summary';
    const elementIds = new Set(issues.flatMap((issue) => issue.elements));
    const needs = (options.needs ?? []).filter((need) => knowledge.elements
      .some((element) => elementIds.has(element.id) && element.needs.includes(need.id)));

    return {
      domain: knowledge.domain,
      knowledge: { id: knowledge.id, version: knowledge.version },
      stance: knowledge.stance,
      notices: knowledge.notices ?? [],
      issues: issues.map((issue) => ({
        issueId: issue.id, title: issue.title, caseTypes: issue.caseTypes,
        elementCount: issue.elements.length,
        criticalCount: knowledge.elements.filter((element) => issue.elements.includes(element.id) && element.critical).length,
        routing: (issue.routing ?? []).map((hint) => hint.action),
        ...(detail === 'elements' ? {
          elements: knowledge.elements.filter((element) => issue.elements.includes(element.id)).map((element) => ({
            elementId: element.id, title: element.title, critical: element.critical,
            burden: element.burden, materials: materialLabels(element.materials),
            statute: element.statute ?? [],
            ...(element.minimumSupport === 'document' ? { requirement: '要求书证' } : {}),
            ...(element.negative === true ? { negative: true } : {}),
            ...(element.localCaliber ? { localCaliber: element.localCaliber } : {}),
          })),
        } : {}),
      })),
      ...(detail === 'needs' ? {
        needs: needs.map((need) => ({ id: need.id, question: need.question, reason: need.reason })),
      } : {}),
    };
  };

  return [
    defineAgentTool({
      id: 'labor.checklist', version: 1, effect: 'read',
      description: '列出劳动法接案需要判断的争点、每个争点要看哪些要件、每项要件由谁举证、需要哪类材料。无需先整理材料，可在阅读前使用。',
      input: checklistInput.input, inputSchema: checklistInput.inputSchema,
      execute: async (input: ChecklistInput) => checklist(input, options.knowledge),
    }),

    defineAgentTool({
      id: 'labor.assess', version: 1, effect: 'read',
      description: '对一次已完成的整理运行做劳动法要件核对：输出每个争点与要件的状态、证据条数、缺口数量与提示。只读，不修改案件。',
      input: runInput.input, inputSchema: runInput.inputSchema,
      execute: async (input: RunInput, context: AgentToolContext) => {
        const runId = assertUuid(input.runId, 'runId');
        const knowledge = knowledgeFor(options.knowledge, input.stance);
        const assessment = assessRun(knowledge, await load(context, runId));
        return assessSummary(assessment);
      },
    }),

    defineAgentTool({
      id: 'labor.gaps', version: 1, effect: 'read',
      description: '列出缺口清单：缺哪个要件的材料、缺了之后对谁不利、建议补什么材料。这是"完全没有材料"的缺口唯一出口，底稿区块放不下它们。',
      input: runInput.input, inputSchema: runInput.inputSchema,
      execute: async (input: RunInput, context: AgentToolContext) => {
        const runId = assertUuid(input.runId, 'runId');
        const knowledge = knowledgeFor(options.knowledge, input.stance);
        const assessment = assessRun(knowledge, await load(context, runId));
        return {
          runId: assessment.runId,
          stance: assessment.stance,
          total: assessment.gaps.length,
          gaps: assessment.gaps.map((gap) => {
            const element = knowledge.elements.find((item) => item.id === gap.elementId);
            return {
              issueId: gap.issueId,
              elementId: gap.elementId,
              elementTitle: element?.title ?? gap.elementId,
              kind: gap.kind,
              consequence: gap.consequence,
              action: gap.action,
              materials: materialLabels(gap.materials),
              evidenceCount: gap.findingIds.length,
              statute: gap.sourceIds,
              ...(gap.detail === undefined ? {} : { detail: gap.detail }),
            };
          }),
          route: assessment.route.map((hit) => ({ issueId: hit.issueId, title: hit.title, score: hit.score, reasons: hit.reasons })),
          checks: assessment.checks,
          proofTasks: buildProofTasks(knowledge, assessment).map((task) => ({
            id: task.id, issueId: task.issueId, elementId: task.elementId,
            goal: task.goal, materials: materialLabels(task.materials),
            standard: task.standard === 'document' ? '要求书证' : '陈述即可',
            burden: task.burden, basis: task.basis, gapKind: task.gapKind,
          })),
          warnings: assessment.warnings,
        };
      },
    }),

    defineAgentTool({
      id: 'labor.paths', version: 1, effect: 'read',
      description: '列出某次整理运行下同一争点的全部可能路径（如单位的单方解除、劳动者的被迫解除、协商一致），每条路径各自的成立条件、缺口、法律结果与测算入口。路径并列陈列，不排序、不推荐。',
      input: runInput.input, inputSchema: runInput.inputSchema,
      execute: async (input: RunInput, context: AgentToolContext) => {
        const runId = assertUuid(input.runId, 'runId');
        const knowledge = knowledgeFor(options.knowledge, input.stance);
        const assessment = assessRun(knowledge, await load(context, runId));
        return {
          runId: assessment.runId,
          stance: assessment.stance,
          total: assessment.paths.length,
          paths: assessment.paths.map((path) => ({
            issueId: path.issueId,
            pathId: path.pathId,
            name: path.name,
            state: path.state,
            stateLabel: PATH_LABEL[path.state] ?? path.state,
            outcome: path.outcome,
            met: path.met,
            missing: path.missing,
            blockedBy: path.blockedBy,
            ...(path.calcPath === undefined ? {} : {
              calc: { tool: 'labor.amount', path: path.calcPath, note: '金额需另行测算；同一案件的多条路径应分别调用，本工具不择高。' },
            }),
            statute: path.statute,
          })),
          warnings: assessment.warnings,
          reminder: '多条路径并列，选哪一条由承办人根据事实核实结果决定；本工具不作推荐，也不按最高金额排序。',
        };
      },
    }),

    defineAgentTool({
      id: 'labor.defenses', version: 1, effect: 'read',
      description: '列出对方可能提出的抗辩：针对哪个争点、需要哪些事实才可能提出、材料中有无迹象、命中后的法律效果、我方需要准备或补充的材料。抗辩是可能性判断，不是结论。',
      input: runInput.input, inputSchema: runInput.inputSchema,
      execute: async (input: RunInput, context: AgentToolContext) => {
        const runId = assertUuid(input.runId, 'runId');
        const knowledge = knowledgeFor(options.knowledge, input.stance);
        const assessment = assessRun(knowledge, await load(context, runId));
        const active = assessment.defenses.filter((defense) => defense.state !== 'unlikely');
        return {
          runId: assessment.runId,
          stance: assessment.stance,
          total: assessment.defenses.length,
          active: active.length,
          defenses: active.map((defense) => ({
            defenseId: defense.defenseId,
            name: defense.name,
            against: defense.against,
            state: defense.state,
            stateLabel: DEFENSE_LABEL[defense.state] ?? defense.state,
            effect: defense.effect,
            signals: defense.signals,
            met: defense.met,
            missing: defense.missing,
            response: defense.response,
            statute: defense.statute,
          })),
          dormant: assessment.defenses.length - active.length,
          reminder: '抗辩是可能提出的反驳，不是已成立的法律结论；"事实已齐备"仅表示对方具备提出条件，仍需承办人核对。',
        };
      },
    }),

    defineAgentTool({
      id: 'labor.opinions', version: 1, effect: 'read',
      description: '对评价性要件（如「严重违纪是否站得住」「解除协议是否显失公平」）给出倾向意见：倾向 + 把握度 + 理由 + 可核对的原文引用。这是参考意见，不是法律结论，也不会改变要件状态。一次评估只调用一次模型。',
      input: opinionInput.input, inputSchema: opinionInput.inputSchema,
      execute: async (input: OpinionInput, context: AgentToolContext) => {
        const runId = assertUuid(input.runId, 'runId');
        const knowledge = knowledgeFor(options.knowledge, input.stance);
        const run = await load(context, runId);
        const assessment = assessRun(knowledge, run);
        const specs = knowledge.opinions ?? [];

        if (specs.length === 0) {
          return { enabled: false, reason: '本知识包没有配置评价性要件的提问模板。' };
        }
        const model = context.services?.model ?? options.model;
        if (model === undefined) {
          return {
            enabled: false,
            reason: '插件未注入模型，评价性要件只能人工判断。可在装配时传入 createLaborPlugin({ model })。',
            pending: specs.map((spec) => ({
              elementId: spec.elementId,
              question: spec.question,
              factors: spec.factors,
              state: assessment.elements.find((element) => element.elementId === spec.elementId)?.state ?? 'absent',
            })),
          };
        }

        const states = new Map(assessment.elements.map((element) => [
          element.elementId, element.evaluationPending ? element.informationState : element.state,
        ]));
        const only = input.elementId === undefined ? undefined : specs.filter((spec) => spec.elementId === input.elementId);
        if (only !== undefined && only.length === 0) {
          throw new AgentToolError('LABOR_INPUT_INVALID', `没有该评价性要件的提问模板：${input.elementId}`);
        }
        const active = (only ?? specs).filter((spec) => states.get(spec.elementId) !== 'not_applicable');
        if (active.length === 0) {
          return { enabled: true, count: 0, opinions: [], reason: '本次运行没有需要评估的评价性要件。' };
        }

        try {
          const result = await evaluateOpinions({ specs: active, run, states }, model, context.signal ? { signal: context.signal } : {});
          return {
            enabled: true,
            runId: assessment.runId,
            stance: assessment.stance,
            model: result.model,
            promptVersion: result.promptVersion,
            inputDigest: result.inputDigest,
            count: result.opinions.length,
            opinions: result.opinions.map((opinion) => {
              const element = assessment.elements.find((item) => item.elementId === opinion.elementId);
              return {
                elementId: opinion.elementId,
                title: element?.title ?? opinion.elementId,
                materialState: states.get(opinion.elementId) ?? 'absent',
                tendency: opinion.tendency,
                tendencyLabel: TENDENCY_LABEL[opinion.tendency],
                confidence: opinion.confidence,
                confidenceLabel: CONFIDENCE_LABEL[opinion.confidence],
                reasoning: opinion.reasoning,
                citations: opinion.citations,
                missingFactors: opinion.missingFactors,
              };
            }),
            reminder: '这是参考意见，不是法律结论：它不改变任何要件状态，也可能出错；请以引用原文为准自行判断。',
          };
        } catch (error) {
          if (error instanceof OpinionError) throw new AgentToolError(error.code === 'OPINION_QUOTE_INVALID' ? 'LABOR_OPINION_UNCITED' : 'LABOR_OPINION_INVALID', error.message);
          throw error;
        }
      },
    }),

    defineAgentTool({
      id: 'labor.amount', version: 1, effect: 'read',
      description: '按指定路径测算金额（经济补偿／违法解除赔偿金／代通知金／二倍工资／加班费）。同一案件的多条路径须分别调用；本工具不自动择高、不给推荐方案，每个结果都带公式、参数与假设。',
      input: amountInput.input, inputSchema: amountInput.inputSchema,
      execute: async (input: AmountInput) => {
        const { path, monthlyWage } = input;
        if (!(monthlyWage >= 0)) throw new AgentToolError('LABOR_INPUT_INVALID', 'monthlyWage 必须是非负数。');
        switch (path) {
          case 'severance': {
            if (input.totalMonths === undefined) throw new AgentToolError('LABOR_INPUT_INVALID', '经济补偿测算需要 totalMonths。');
            const result = severance(monthlyWage, input.totalMonths, params);
            return { path, value: result.value, ...trace(result) };
          }
          case 'severance-segmented': {
            if (input.startDate === undefined || input.endDate === undefined) {
              throw new AgentToolError('LABOR_INPUT_INVALID', '分段经济补偿需要 startDate 与 endDate。');
            }
            const result = segmentedSeverance(monthlyWage, input.startDate, input.endDate, params);
            return { path, value: result.value, ...trace(result) };
          }
          case 'illegal-termination': {
            if (input.totalMonths === undefined) throw new AgentToolError('LABOR_INPUT_INVALID', '违法解除赔偿金测算需要 totalMonths。');
            const result = illegalTerminationDamages(monthlyWage, input.totalMonths, params);
            return { path, value: result.value, ...trace(result) };
          }
          case 'notice-pay': {
            const result = noticePay(monthlyWage, params);
            return { path, value: result.value, ...trace(result) };
          }
          case 'double-wage': {
            if (input.unsignedMonths === undefined) throw new AgentToolError('LABOR_INPUT_INVALID', '二倍工资测算需要 unsignedMonths。');
            if ((input.partialWorkDays === undefined) !== (input.dailyWage === undefined)) throw new AgentToolError('LABOR_INPUT_INVALID', '零头工作日与日工资须同时提供。');
            const result = doubleWage(monthlyWage, input.unsignedMonths, params, input.partialWorkDays === undefined ? undefined : { workDays: input.partialWorkDays, dailyWage: input.dailyWage! });
            return { path, value: result.value, ...trace(result) };
          }
          case 'overtime': {
            const result = overtimePay(monthlyWage, {
              weekday: input.weekdayHours ?? 0, restDay: input.restDayHours ?? 0, holiday: input.holidayHours ?? 0,
            }, params);
            return { path, value: result.value, ...trace(result) };
          }
        }
      },
    }),

    defineAgentTool({
      id: 'labor.deadline', version: 1, effect: 'read',
      description: '测算劳动仲裁时效：给出起算日与基准日，返回是否临近或已过、截止日与依据。不推断"知道或应当知道"的时点，起算日须由使用者提供。',
      input: deadlineInput.input, inputSchema: deadlineInput.inputSchema,
      execute: async (input: DeadlineInput) => {
        const interruptions = (input.interruptions ?? '').split(/[,，、;；\s]+/u).map((item) => item.trim()).filter((item) => item.length > 0);
        const result = arbitrationLimitation({
          from: input.from, today: input.today, kind: input.kind, relationOngoing: input.relationOngoing,
          ...(interruptions.length === 0 ? {} : { interruptions }),
          ...(input.localCaliberConfirmed === undefined ? {} : { localCaliberConfirmed: input.localCaliberConfirmed }),
        }, params);
        return { value: result.value, ...trace(result) };
      },
    }),
  ];
}

/** 供测试与外部检查使用：当前参数包的核验状态。 */
export const laborParamsStatus = (params: LaborParams = PLACEHOLDER_PARAMS): { verified: boolean; region: string; note: string } =>
  ({ verified: params.verified, region: params.region, note: params.note });
