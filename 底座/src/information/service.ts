import { z } from 'zod';
import { createRuntime } from '../runtime.ts';
import { CASE_CAPABILITIES, caseIdSchema } from '../cases/contracts.ts';
import { textVersionViewSchema } from '../materials/text-contracts.ts';
import { IntakeLoop } from '../loops/engine.ts';
import { LoopRunStore } from '../loops/store.ts';
import { loopLimitsSchema, type LoopSource, type LoopCheckpoint } from '../loops/contracts.ts';
import { entityBindingSchema, structuredNeedSchema } from './contracts.ts';
import { createInformationPlugins } from './plugins.ts';
import { InformationError } from './errors.ts';
import type { ProfessionalReviewer } from './professional.ts';
import type { JsonModel } from './model.ts';

export const informationPlanSchema = z.strictObject({
  goal: z.string().trim().min(1),
  selections: z.array(z.strictObject({ materialId: z.uuid(), versionId: z.uuid() })).min(1),
  needs: z.array(structuredNeedSchema).min(1),
  readingMode: z.enum(['per_need', 'batch']).default('per_need'),
  bindings: z.array(entityBindingSchema).optional(),
  sourceKinds: z.record(z.uuid(), z.enum(['party_statement', 'document_record'])).optional(),
  limits: loopLimitsSchema.default({ maxRounds: 4, maxReads: 12 }),
  maxModelCalls: z.number().int().min(1).max(200).default(24),
});
export type InformationPlan = z.input<typeof informationPlanSchema>;
/** Run the same four functions from a terminal or a future UI, with explicit case/version scope. */
export async function organizeCaseInformation(input: {
  dataDir: string;
  caseId: string;
  plan: InformationPlan;
  model: JsonModel;
  signal?: AbortSignal;
  reviewer?: ProfessionalReviewer;
  reuseRunId?: string;
  /** Keep verified reads when an independent model result cannot pass validation. */
  allowPartialReads?: boolean;
  execution?: {
    resume?: LoopCheckpoint;
    modelCallsUsed?: number;
    currentCaseRevision?: () => number;
    onCheckpoint?: (checkpoint: LoopCheckpoint) => Promise<void>;
    onModelCall?: () => Promise<void>;
  };
}) {
  const started = Date.now();
  const caseId = caseIdSchema.parse(input.caseId);
  const plan = informationPlanSchema.parse(input.plan);
  const selectedIds = new Set(plan.selections.map((item) => item.materialId));
  if (Object.keys(plan.sourceKinds ?? {}).some((id) => !selectedIds.has(id)))
    throw new InformationError(
      'INFORMATION_SCOPE_INVALID',
      'Source annotations must belong to explicitly selected materials.',
    );
  let calls = input.execution?.modelCallsUsed ?? 0;
  const boundedModel: JsonModel = {
    id: input.model.id,
    model: input.model.model,
    complete: async (request) => {
      if (input.signal?.aborted)
        throw new InformationError('INFORMATION_CANCELLED', 'Information reading was cancelled.');
      if (++calls > plan.maxModelCalls)
        throw new InformationError(
          'INFORMATION_MODEL_BUDGET',
          'The model-call budget was exhausted; no current result was committed.',
        );
      await input.execution?.onModelCall?.();
      return input.model.complete(request);
    },
  };
  const { plugins, refs } = createInformationPlugins({
    model: boundedModel,
    needs: plan.needs,
    readingMode: plan.readingMode,
    ...(input.allowPartialReads ? { allowPartialReads: true } : {}),
    ...(input.reviewer ? { reviewer: input.reviewer } : {}),
    ...(input.reuseRunId ? { reuseRun: await new LoopRunStore(input.dataDir).read({ caseId, runId: input.reuseRunId }) } : {}),
    ...(plan.bindings ? { bindings: plan.bindings } : {}),
    extraction: {
      ...(plan.sourceKinds ? { sourceKinds: plan.sourceKinds } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  });
  const host = await createRuntime({ dataDir: input.dataDir, plugins });
  try {
    const sources: LoopSource[] = [];
    for (const selection of plan.selections) {
      const result = await host.invoke(CASE_CAPABILITIES.readVersion, { caseId, ...selection });
      if (result.status !== 'success')
        throw new InformationError('INFORMATION_SOURCE_INVALID', 'Selected case text version could not be read.');
      const { version } = textVersionViewSchema.parse(result.data);
      sources.push({ ...selection, textSha256: version.textSha256 });
    }
    const run = await new IntakeLoop(host).run(
      {
        caseId,
        goal: plan.goal,
        sources,
        limits: plan.limits,
        ...refs,
        ...(plan.readingMode === 'batch' ? { readingMode: 'batch' as const } : {}),
      },
      {
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.execution?.resume ? { resume: input.execution.resume } : {}),
        ...(input.execution?.currentCaseRevision ? { currentCaseRevision: input.execution.currentCaseRevision } : {}),
        ...(input.execution?.onCheckpoint ? { onCheckpoint: input.execution.onCheckpoint } : {}),
      },
    );
    if (input.signal?.aborted)
      throw new InformationError('INFORMATION_CANCELLED', 'Information processing was cancelled before saving.');
    const attempts = run.rounds.flatMap((round) => round.attempts);
    const batches = [
      ...new Map(
        attempts.flatMap((attempt) => (attempt.batch ? [[attempt.batch.id, attempt.batch] as const] : [])),
      ).values(),
    ];
    run.metrics = {
      modelCalls: calls,
      readBatches: new Set(attempts.map((attempt, index) => attempt.batch?.id ?? `read-${index}`)).size,
      needSourceChecks: attempts.reduce((total, attempt) => total + attempt.examined.length, 0),
      elapsedMs: Date.now() - started,
      readingMode: plan.readingMode,
      batchSplits: batches.reduce((total, batch) => total + (batch.splits ?? 0), 0),
      singleNeedReads: batches.reduce((total, batch) => total + (batch.singleReads ?? 0), 0),
    };
    return await new LoopRunStore(input.dataDir).save(run, input.signal ? { signal: input.signal } : {});
  } finally {
    await host.stop();
  }
}
