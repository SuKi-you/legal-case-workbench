import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { defineCapability, type PluginDefinition } from '../contracts.ts';
import {
  loopDeclarationInputSchema,
  loopDeclarationSchema,
  loopReadingInputSchema,
  loopReadingSchema,
  loopReviewInputSchema,
  loopReviewSchema,
  loopBatchReadingInputSchema,
  loopBatchReadingSchema,
  type LoopSource,
  type LoopReadRequest,
  type LoopRun,
} from '../loops/contracts.ts';
import {
  structuredNeedSchema,
  informationAnalysisSchema,
  type StructuredNeed,
  type EntityBinding,
} from './contracts.ts';
import { compareInformation } from './compare.ts';
import { evaluateInformationNeeds } from './coverage.ts';
import { extractInformation, type InformationExtractionOptions } from './extract.ts';
import type { JsonModel } from './model.ts';
import { extractInformationBatch } from './batch.ts';
import { professionalReviewSchema, validateProfessionalReview, type ProfessionalReview, type ProfessionalReviewer } from './professional.ts';
import { InformationError } from './errors.ts';
import { canonicalJson } from '../utils/canonical.ts';

export interface InformationPluginOptions {
  model: JsonModel;
  needs: readonly StructuredNeed[];
  bindings?: readonly EntityBinding[];
  prefix?: string;
  extraction?: InformationExtractionOptions;
  reviewer?: ProfessionalReviewer;
  readingMode?: 'per_need' | 'batch';
  allowPartialReads?: boolean;
  /** The application passes only an already validated, same-case saved run. */
  reuseRun?: LoopRun;
}
const sourceKey = (source: LoopSource) => `${source.materialId}/${source.versionId}/${source.textSha256}`;
type VerifiedRead = z.infer<typeof loopReadingSchema>;
const readKey = (request: LoopReadRequest, source: LoopSource) => JSON.stringify([
  request.needId, request.checkId ?? null, request.checkId ? request.instruction : null, sourceKey(source),
]);
const versionWithoutReuse = (version: string) => version.replace(/:reuse:[a-f\d-]{36}$/iu, '');

function indexVerifiedReads(run: LoopRun): Map<string, VerifiedRead> {
  const reads = new Map<string, VerifiedRead>();
  const findings = new Map(run.findings.map(finding => [finding.id, finding]));
  for (const attempt of run.rounds.flatMap(round => round.attempts)) {
    const targeted = attempt.request.sources ?? run.sources;
    const source = attempt.examined[0];
    if (attempt.readIssues?.length || attempt.examined.length !== 1 || targeted.length !== 1 ||
      !source || sourceKey(targeted[0]!) !== sourceKey(source)) continue;
    const candidates: VerifiedRead['candidates'] = [];
    for (const id of attempt.findingIds) {
      const finding = findings.get(id);
      if (!finding || finding.needId !== attempt.request.needId || !finding.record ||
        finding.citations.some(citation => sourceKey(citation) !== sourceKey(source))) break;
      const { statement, record, citations } = finding;
      candidates.push({ statement, record, citations });
    }
    if (candidates.length !== attempt.findingIds.length) continue;
    const key = readKey(attempt.request, source);
    const previous = reads.get(key);
    if (previous) previous.candidates.push(...candidates);
    else reads.set(key, {
      examined: [source], candidates, note: `复用同案固定文字版本上已经核验的读取。基线运行：${run.id}。`,
    });
  }
  return reads;
}

/** Professional differences are declared as data; no labor-law fields are built into this factory. */
export function createInformationPlugins(options: InformationPluginOptions) {
  const needs = structuredNeedSchema.array().min(1).parse(options.needs);
  if (needs.some((need) => !need.spec))
    throw new InformationError(
      'INFORMATION_NEED_SPEC_REQUIRED',
      'Every professional need must declare its structured scope and satisfaction conditions.',
    );
  if (new Set(needs.map((need) => need.id)).size !== needs.length)
    throw new InformationError('INFORMATION_NEED_INVALID', 'Professional need IDs must be unique.');
  const prefix = options.prefix?.trim() || 'information';
  const refs = Object.freeze({
    declare: { id: `${prefix}.declare`, version: 1 },
    read: { id: `${prefix}.read`, version: 1 },
    review: { id: `${prefix}.review`, version: 1 },
    ...(options.readingMode === 'batch' ? { readBatch: { id: `${prefix}.read-batch`, version: 1 } } : {}),
  });
  const bindings = structuredClone(options.bindings ?? []);
  const sourceKinds = Object.entries(options.extraction?.sourceKinds ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const configurationFor = (kinds: typeof sourceKinds) => createHash('sha256')
    .update(
      JSON.stringify({
        needs,
        bindings,
        sourceKinds: kinds,
        maxSegmentChars: options.extraction?.maxSegmentChars ?? 5000,
        maxSegments: options.extraction?.maxSegments ?? 32,
        maxRepairAttempts: options.extraction?.maxRepairAttempts ?? 1,
        verifySemantics: options.extraction?.verifySemantics !== false,
        readingMode: options.readingMode ?? 'per_need',
        ...(options.allowPartialReads ? { allowPartialReads: true } : {}),
        reviewer: options.reviewer ? [options.reviewer.id, options.reviewer.version, options.reviewer.profileId] : null,
      }),
    )
    .digest('hex');
  const configuration = configurationFor(sourceKinds);
  const readerId = `${prefix}.reader`;
  const readerVersion = (config: string) =>
    `1.0.0:${options.model.id}:${options.model.model}:${options.allowPartialReads ? 'prompt-6-partial' : 'prompt-5'}:${config}`;
  const baseline = options.reuseRun;
  let verifiedReads: Map<string, VerifiedRead> | undefined;
  if (baseline && options.extraction?.verifySemantics !== false && canonicalJson(baseline.needs) === canonicalJson(needs)) {
    const ids = new Set(baseline.sources.map(source => source.materialId));
    const expected = readerVersion(configurationFor(sourceKinds.filter(([id]) => ids.has(id))));
    const matches = (provider: LoopRun['providers']['read'], ref: typeof refs.read) =>
      provider.pluginId === readerId && versionWithoutReuse(provider.pluginVersion) === expected
      && provider.capability.id === ref.id && provider.capability.version === ref.version;
    if (matches(baseline.providers.read, refs.read) && (refs.readBatch
      ? baseline.providers.readBatch && matches(baseline.providers.readBatch, refs.readBatch)
      : !baseline.providers.readBatch)) {
      verifiedReads = indexVerifiedReads(baseline);
    }
  }
  const reuse = (caseId: string, request: LoopReadRequest, documents: readonly LoopSource[]) => {
    if (caseId !== baseline?.caseId || documents.length !== 1) return undefined;
    const reading = verifiedReads?.get(readKey(request, documents[0]!));
    return reading ? structuredClone(reading) : undefined;
  };
  const plugins: PluginDefinition[] = [
    {
      manifest: { id: `${prefix}.needs-and-review`, version: `2.0.0:${configuration}`, apiVersion: 1 },
      capabilities: [
        defineCapability({
          ...refs.declare,
          input: loopDeclarationInputSchema,
          output: loopDeclarationSchema,
          execute: ({ sources }) => {
            if (!sources?.length)
              throw new InformationError(
                'INFORMATION_SCOPE_REQUIRED',
                'Declare needs with the selected source version scope.',
              );
            return {
              status: 'success',
              data: {
                needs,
                requests: needs.map((need) => ({
                  needId: need.id,
                  instruction: `按需求“${need.question}”读取指定材料。`,
                  reason: need.reason,
                  sources: [sources[0]!],
                })),
              },
            };
          },
        }),
        defineCapability({
          ...refs.review,
          input: loopReviewInputSchema,
          output: loopReviewSchema,
          execute: async ({ caseId, goal, needs: declared, findings, attempts, sources }) => {
            if (!sources?.length)
              throw new InformationError(
                'INFORMATION_SCOPE_REQUIRED',
                'Review needs the complete selected source scope.',
              );
            const comparison = compareInformation(findings, { bindings });
            const coverage = evaluateInformationNeeds({
              needs: declared,
              findings,
              sources,
              attempts,
              conflicts: comparison.conflicts,
            });
            const analysis = informationAnalysisSchema.parse({ version: 1, ...comparison, needs: coverage });
            const assessments = coverage.map((item) => ({
              needId: item.needId,
              status:
                item.satisfaction === 'not_applicable'
                  ? ('not_applicable' as const)
                  : item.consistency === 'conflicting'
                    ? ('conflicting' as const)
                    : item.satisfaction === 'satisfied' && item.unread.length === 0
                      ? ('satisfied' as const)
                      : ('unresolved' as const),
              findingIds: item.findingIds,
              reason:
                item.unread.length > 0 && item.satisfaction !== 'not_applicable'
                  ? `${item.reason} 仍有 ${item.unread.length} 份选定材料尚未按本需求核对，先读取这些材料。`
                  : item.reason,
            }));
            const rejected = new Map<string, Set<string>>();
            for (const attempt of attempts) {
              const keys = rejected.get(attempt.request.needId) ?? new Set<string>();
              for (const { source } of attempt.readIssues ?? []) keys.add(sourceKey(source));
              rejected.set(attempt.request.needId, keys);
            }
            for (const item of coverage) {
              for (const source of item.examined) rejected.get(item.needId)?.delete(sourceKey(source));
            }
            const blocked = (needId: string, source: LoopSource) => rejected.get(needId)?.has(sourceKey(source)) === true;
            const nextRequests = coverage.flatMap((item) => {
              const next = item.unread.find((source) => !blocked(item.needId, source));
              if (item.satisfaction === 'not_applicable' || !next) return [];
              return [{
                needId: item.needId,
                sources: [next],
                instruction: `按需求“${declared.find((need) => need.id === item.needId)!.question}”读取指定的下一份材料。`,
                reason: '已有陈述继续保留，检查尚未读取的来源以寻找补充、支持或差异。',
              }];
            });
            let professionalReview;
            if (options.reviewer) {
              const input = { caseId, goal, needs: declared, findings, analysis, sources, attempts };
              const checked = professionalReviewSchema.parse(await options.reviewer.review(structuredClone(input)));
              validateProfessionalReview(checked, input);
              let redirected = false;
              const actions: ProfessionalReview['actions'] = checked.actions.flatMap((action) => {
                if (action.kind !== 'read') return [action];
                const targeted = action.sources ?? sources;
                const failed = targeted.filter((source) => blocked(action.needId, source));
                if (failed.length === 0) return [action];
                redirected = true;
                const allowed = targeted.filter((source) => !blocked(action.needId, source));
                return [
                  ...(allowed.length ? [{ ...action, sources: allowed }] : []),
                  { ...action, kind: 'human_review', sources: failed, reason: '本轮模型结果经有限纠正仍未通过校验。',
                    instruction: '对照指定材料原文与本需求进行人工核对，保留已通过校验的其他材料。' },
                ];
              });
              const decision = redirected
                ? (actions.some((action) => action.kind === 'read') ? 'continue' : 'human_review')
                : checked.decision;
              professionalReview = {
                ...checked,
                actions,
                decision,
                reviewer: {
                  id: options.reviewer.id,
                  version: options.reviewer.version,
                  profileId: options.reviewer.profileId,
                },
              };
              for (const action of actions.filter((action) => action.kind === 'read')) {
                const targets = action.sources ?? sources;
                if (options.allowPartialReads) {
                  const index = nextRequests.findIndex((item) => !('checkId' in item) && item.needId === action.needId
                    && item.sources.every((source) => targets.some((target) => sourceKey(target) === sourceKey(source))));
                  if (index !== -1) nextRequests.splice(index, 1);
                }
                nextRequests.push({
                  needId: action.needId,
                  instruction: action.instruction,
                  reason: action.reason,
                  sources: targets,
                  checkId: action.checkId,
                } as (typeof nextRequests)[number]);
              }
            }
            return {
              status: 'success',
              data: { assessments, nextRequests, analysis, ...(professionalReview ? { professionalReview } : {}) },
            };
          },
        }),
      ],
    },
    {
      manifest: {
        id: readerId,
        version: readerVersion(configuration) + (baseline ? `:reuse:${baseline.id}` : ''),
        apiVersion: 1,
      },
      capabilities: [
        ...(refs.readBatch
          ? [
              defineCapability({
                ...refs.readBatch,
                input: loopBatchReadingInputSchema,
                output: loopBatchReadingSchema,
                execute: async ({ caseId, documents, needs: batchNeeds, requests }) => {
                  const cached: z.infer<typeof loopBatchReadingSchema>['results'] = [];
                  const pending = batchNeeds.flatMap((need) => {
                    const action = requests.find((item) => item.needId === need.id);
                    const reading = action && reuse(caseId, action, documents);
                    if (reading) {
                      cached.push({ needId: need.id, ...reading });
                      return [];
                    }
                    return [action?.checkId
                      ? { ...need, question: `${need.question}\n本轮专业补查：${action.instruction}` }
                      : need];
                  });
                  if (pending.length === 0) return { status: 'success', data: { results: cached } };
                  const fresh = await extractInformationBatch(options.model, documents, pending,
                    { ...options.extraction, ...(options.allowPartialReads ? { allowPartialReads: true } : {}) });
                  return { status: 'success', data: { ...fresh, results: [...cached, ...fresh.results] } };
                },
              }),
            ]
          : []),
        defineCapability({
          ...refs.read,
          input: loopReadingInputSchema,
          output: loopReadingSchema,
          execute: async ({ caseId, documents, need, request }) => {
            const cached = reuse(caseId, request, documents);
            if (cached) return { status: 'success', data: cached };
            if (need.spec?.applicable === false)
              return {
                status: 'success',
                data: { examined: [], candidates: [], note: '专业插件已将该需求声明为不适用。' },
              };
            const requested = request.checkId
              ? { ...need, question: `${need.question}\n本轮专业补查：${request.instruction}` }
              : need;
            if (options.allowPartialReads) {
              const { results } = await extractInformationBatch(options.model, documents, [requested], {
                ...options.extraction, allowPartialReads: true,
              });
              const { needId: _, ...reading } = results[0]!;
              return { status: 'success', data: reading };
            }
            return {
              status: 'success',
              data: await extractInformation(
                options.model,
                documents,
                [requested],
                { ...options.extraction, verifySemantics: options.extraction?.verifySemantics !== false },
              ),
            };
          },
        }),
      ],
    },
  ];
  return { plugins, refs };
}
