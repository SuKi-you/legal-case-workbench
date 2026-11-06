/**
 * 通用结构层 · 评价性要件的参考意见
 *
 * 这一层是**唯一允许调用模型**的地方，用途只有一个：
 * 对"严重违纪是否站得住""协议是否显失公平"这类主观评价，给出倾向 + 把握度 + 理由。
 *
 * 边界（每一道都是刻意的）：
 * - 输出不改变任何 element.state；
 * - 只能给 likely / unlikely / unclear，永远不给"成立/不成立"；
 * - 每条理由必须引用本运行内的 finding，且引文必须能在原文里逐字找到；
 * - 引用对不上就整条拒绝，不做"宽容解析"。
 */
import { createHash } from 'node:crypto';
import type { ElementState, Opinion, OpinionCitation, OpinionSpec, RunView } from './contracts.ts';

export const OPINION_PROMPT_VERSION = 'opinion-2';
const MAX_REASONING = 1200;
const MAX_QUOTE = 400;
const MAX_FINDINGS_IN_PROMPT = 60;

/**
 * 与底座 JsonModel 结构兼容：只要求最少的三项，多出来的可选字段（如 reasoning）不影响赋值。
 */
export interface OpinionModel {
  readonly id: string;
  readonly model: string;
  complete(request: { system: string; user: string; signal?: AbortSignal }): Promise<unknown>;
}

export class OpinionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'OpinionError';
    this.code = code;
  }
}

export interface OpinionRequest {
  readonly specs: readonly OpinionSpec[];
  readonly run: RunView;
  readonly states: ReadonlyMap<string, ElementState>;
}

/** 组装一次调用的 system/user；所有评价性要件放在同一次调用里，避免按要件多次计费。 */
export function buildOpinionRequest(input: OpinionRequest): { system: string; user: string } {
  const system = [
    '你是法律材料整理助手的评估模块。你只做一件事：根据给定的案件记录，对指定的评价性要件给出「倾向 + 把握度 + 简短理由」，供承办律师参考。',
    '硬性要求：',
    '1. 只能使用我提供的记录，不得引入任何未提供的事实、法条、案例或常识性结论。',
    '2. 每条理由必须引用至少一条记录：在 citations 里给出 findingId 和**逐字**原文片段（必须与记录文字完全一致，不得改写、不得拼接）。',
    '3. tendency 只能取 likely / unlikely / unclear；把握不足时必须用 unclear，不得为了给出答案而猜测。',
    '4. 不得输出「成立/不成立」「胜诉/败诉」「能拿多少钱」这类结论；你给的是倾向，不是判断。',
    '5. 对每个要件列出你无法从材料中确认的因素（missingFactors）。',
    '6. 只输出 JSON，不要任何解释性文字，也不要 markdown 代码块。',
    '',
    '输出格式：',
    '{"opinions":[{"elementId":"...","tendency":"likely|unlikely|unclear","confidence":"low|medium|high","reasoning":"不超过 300 字","citations":[{"findingId":"...","quote":"逐字片段"}],"missingFactors":["..."]}]}',
  ].join('\n');

  if (input.run.findings.length > MAX_FINDINGS_IN_PROMPT) throw new OpinionError('OPINION_SCOPE_LIMIT', `本次有 ${input.run.findings.length} 条记录，超过单次评估范围 ${MAX_FINDINGS_IN_PROMPT}；请缩小范围，不能静默遗漏。`);
  const findings = input.run.findings.map((finding) => ({
    id: finding.id,
    needId: finding.needId,
    statement: finding.statement.slice(0, 400),
    ...(finding.record?.period ? { period: finding.record.period } : {}),
    ...(finding.record?.value?.normalized ? { value: finding.record.value.normalized } : {}),
    quotes: finding.citations.map((citation) => citation.quote.slice(0, MAX_QUOTE)),
  }));

  const user = JSON.stringify({
    task: '评价性要件评估',
    caseGoal: input.run.goal,
    runStatus: input.run.status,
    items: input.specs.map((spec) => ({
      elementId: spec.elementId,
      question: spec.question,
      factors: spec.factors,
      ...(spec.guidance === undefined ? {} : { guidance: spec.guidance }),
      currentState: input.states.get(spec.elementId) ?? 'absent',
    })),
    findings,
  });

  return { system, user };
}

const TENDENCIES = new Set(['likely', 'unlikely', 'unclear']);
const CONFIDENCES = new Set(['low', 'medium', 'high']);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 引文必须能在该 finding 的陈述或任一引用片段里逐字找到。 */
function quoteSupported(run: RunView, findingId: string, quote: string): boolean {
  const finding = run.findings.find((item) => item.id === findingId);
  if (!finding) return false;
  const haystack = finding.citations.map((citation) => citation.quote);
  return haystack.some((text) => text.includes(quote));
}

/**
 * 严格解析：结构、枚举、引用逐项校验；任何一项不合格整条拒绝。
 * 不做"尽量修补"——修补过的意见无法被承办人核对。
 */
export function parseOpinions(raw: unknown, input: OpinionRequest): Opinion[] {
  if (!isRecord(raw) || !Array.isArray(raw.opinions)) {
    throw new OpinionError('OPINION_OUTPUT_INVALID', '模型输出必须是 {"opinions":[...]}。');
  }
  if (Object.keys(raw).some((key) => key !== 'opinions')) throw new OpinionError('OPINION_OUTPUT_INVALID', '意见结果含未声明字段。');
  const expected = new Map(input.specs.map((spec) => [spec.elementId, spec]));
  const seen = new Set<string>();
  const opinions: Opinion[] = [];

  for (const item of raw.opinions as unknown[]) {
    if (!isRecord(item)) throw new OpinionError('OPINION_OUTPUT_INVALID', 'opinions 的元素必须是对象。');
    const keys = Object.keys(item);
    const allowed = new Set(['elementId', 'tendency', 'confidence', 'reasoning', 'citations', 'missingFactors']);
    for (const key of keys) if (!allowed.has(key)) throw new OpinionError('OPINION_OUTPUT_INVALID', `不允许的字段：${key}`);

    const elementId = item.elementId;
    if (!isText(elementId) || !expected.has(elementId)) throw new OpinionError('OPINION_OUTPUT_INVALID', `未请求的要件：${String(elementId)}`);
    if (seen.has(elementId)) throw new OpinionError('OPINION_OUTPUT_INVALID', `要件重复出现：${elementId}`);
    seen.add(elementId);

    const tendency = item.tendency;
    if (typeof tendency !== 'string' || !TENDENCIES.has(tendency)) {
      throw new OpinionError('OPINION_OUTPUT_INVALID', `${elementId} 的 tendency 必须是 likely/unlikely/unclear。`);
    }
    const confidence = item.confidence;
    if (typeof confidence !== 'string' || !CONFIDENCES.has(confidence)) {
      throw new OpinionError('OPINION_OUTPUT_INVALID', `${elementId} 的 confidence 必须是 low/medium/high。`);
    }
    const materialState = input.states.get(elementId);
    if ((materialState === undefined || ['absent', 'unread', 'needs_review', 'conflicting', 'opposed', 'not_applicable'].includes(materialState))
      && (tendency !== 'unclear' || confidence !== 'low')) {
      throw new OpinionError('OPINION_OUTPUT_INVALID', `${elementId} 的专业材料尚未明确，只能保留 unclear/low，不能凭无关引用给出强倾向。`);
    }
    const reasoning = item.reasoning;
    if (!isText(reasoning) || reasoning.length > MAX_REASONING) {
      throw new OpinionError('OPINION_OUTPUT_INVALID', `${elementId} 的 reasoning 缺失或过长。`);
    }

    if (!Array.isArray(item.citations) || item.citations.length === 0) {
      throw new OpinionError('OPINION_OUTPUT_INVALID', `${elementId} 没有任何引用，意见不可核对。`);
    }
    const citations: OpinionCitation[] = [];
    for (const citation of item.citations as unknown[]) {
      if (!isRecord(citation) || !isText(citation.findingId) || !isText(citation.quote)) {
        throw new OpinionError('OPINION_OUTPUT_INVALID', `${elementId} 的引用结构不完整。`);
      }
      if (citation.quote.length > MAX_QUOTE) throw new OpinionError('OPINION_OUTPUT_INVALID', `${elementId} 的引用过长。`);
      if (!quoteSupported(input.run, citation.findingId, citation.quote)) {
        throw new OpinionError('OPINION_QUOTE_INVALID', `${elementId} 的引用无法在 ${citation.findingId} 中找到：${citation.quote.slice(0, 30)}…`);
      }
      citations.push({ findingId: citation.findingId, quote: citation.quote });
    }

    const missing = item.missingFactors;
    if (!Array.isArray(missing) || missing.some((entry) => typeof entry !== 'string')) {
      throw new OpinionError('OPINION_OUTPUT_INVALID', `${elementId} 的 missingFactors 必须是字符串数组。`);
    }

    opinions.push({
      elementId,
      tendency: tendency as Opinion['tendency'],
      confidence: confidence as Opinion['confidence'],
      reasoning: reasoning.trim(),
      citations,
      missingFactors: (missing as string[]).map((entry) => entry.trim()).filter((entry) => entry.length > 0).slice(0, 20),
    });
  }

  const absent = [...expected.keys()].filter((id) => !seen.has(id));
  if (absent.length > 0) throw new OpinionError('OPINION_OUTPUT_INVALID', `缺少对以下要件的意见：${absent.join('、')}`);
  return opinions;
}

export interface OpinionResult {
  readonly opinions: readonly Opinion[];
  readonly model: { readonly id: string; readonly model: string };
  readonly promptVersion: string;
  readonly inputDigest: string;
}

/** 一次调用评估全部评价性要件。 */
export async function evaluateOpinions(
  input: OpinionRequest,
  model: OpinionModel,
  options: { signal?: AbortSignal } = {},
): Promise<OpinionResult> {
  if (input.specs.length === 0) throw new OpinionError('OPINION_NOTHING_TO_EVALUATE', '本次运行没有评价性要件。');
  const { system, user } = buildOpinionRequest(input);
  if (options.signal?.aborted) throw new OpinionError('OPINION_CANCELLED', '评价已中断。');
  const raw = await model.complete({ system, user, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  if (options.signal?.aborted) throw new OpinionError('OPINION_CANCELLED', '评价已中断，不发布迟到结果。');
  const opinions = parseOpinions(raw, input);
  const inputDigest = createHash('sha256')
    .update(JSON.stringify({ promptVersion: OPINION_PROMPT_VERSION, model: { id: model.id, model: model.model }, system, user }))
    .digest('hex');
  return { opinions, model: { id: model.id, model: model.model }, promptVersion: OPINION_PROMPT_VERSION, inputDigest };
}
