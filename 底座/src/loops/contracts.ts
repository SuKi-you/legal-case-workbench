import { z } from 'zod';
import { savedProfessionalReviewSchema } from '../information/professional.ts';
import { caseIdSchema } from '../cases/contracts.ts';
import { createReferenceSchema, textHashSchema } from '../materials/text-contracts.ts';
import { informationAnalysisSchema, informationRecordSchema, needSpecSchema } from '../information/contracts.ts';

const text = z.string().trim().min(1);
export const loopSourceSchema = z.strictObject({ materialId: z.uuid(), versionId: z.uuid(), textSha256: textHashSchema });
export type LoopSource = z.infer<typeof loopSourceSchema>;
export const loopDocumentSchema = loopSourceSchema.extend({ sourceLabel: text, text: z.string() });
export type LoopDocument = z.infer<typeof loopDocumentSchema>;
export const informationNeedSchema = z.strictObject({ id: text, question: text, reason: text, spec: needSpecSchema.optional() });
export type InformationNeed = z.infer<typeof informationNeedSchema>;
export const loopReadRequestSchema = z.strictObject({ needId: text, instruction: text, reason: text, sources: z.array(loopSourceSchema).min(1).optional(), checkId: text.optional() });
export type LoopReadRequest = z.infer<typeof loopReadRequestSchema>;
export const loopCitationSchema = createReferenceSchema.safeExtend({ textSha256: textHashSchema });
export type LoopCitation = z.infer<typeof loopCitationSchema>;
export const loopCandidateSchema = z.strictObject({ statement: text, citations: z.array(loopCitationSchema).min(1), record: informationRecordSchema.optional() });
export const loopFindingSchema = loopCandidateSchema.extend({ id: z.uuid(), needId: text });
export type LoopFinding = z.infer<typeof loopFindingSchema>;
export const loopDeclarationInputSchema = z.strictObject({ caseId: caseIdSchema, goal: text, sources: z.array(loopSourceSchema).optional() });
export const loopDeclarationSchema = z.strictObject({ needs: z.array(informationNeedSchema).min(1), requests: z.array(loopReadRequestSchema).min(1) });
export const loopReadingInputSchema = z.strictObject({
  caseId: caseIdSchema, round: z.number().int().positive(), need: informationNeedSchema,
  request: loopReadRequestSchema, documents: z.array(loopDocumentSchema).min(1), findings: z.array(loopFindingSchema),
});
export const loopReadIssueCodeSchema = z.enum([
  'INFORMATION_MODEL_OUTPUT_INVALID', 'INFORMATION_BATCH_INCOMPLETE', 'INFORMATION_TOPIC_INVALID',
  'INFORMATION_QUOTE_INVALID', 'INFORMATION_UNGROUNDED_FIELD', 'INFORMATION_SEMANTIC_INVALID',
  'INFORMATION_SEMANTIC_REJECTED',
]);
export const loopReadIssueSchema = z.strictObject({ source: loopSourceSchema, code: loopReadIssueCodeSchema });
export type LoopReadIssue = z.infer<typeof loopReadIssueSchema>;
export function readIssuesFitScope(issues: readonly LoopReadIssue[], examined: readonly LoopSource[], target: readonly LoopSource[]): boolean {
  const key = (source: LoopSource) => `${source.materialId}/${source.versionId}/${source.textSha256}`;
  const keys = issues.map(({ source }) => key(source));
  const allowed = new Set(target.map(key));
  const admitted = new Set(examined.map(key));
  return new Set(keys).size === keys.length && keys.every((item) => allowed.has(item) && !admitted.has(item));
}
export const loopReadingSchema = z.strictObject({
  examined: z.array(loopSourceSchema), candidates: z.array(loopCandidateSchema), note: text,
  readIssues: z.array(loopReadIssueSchema).min(1).optional(),
});
export const loopBatchReadingInputSchema = z.strictObject({
  caseId: caseIdSchema, round: z.number().int().positive(), needs: z.array(informationNeedSchema).min(1).max(8),
  requests: z.array(loopReadRequestSchema).min(1).max(8), documents: z.array(loopDocumentSchema).min(1), findings: z.array(loopFindingSchema),
});
export const loopBatchReadingSchema = z.strictObject({
  results: z.array(loopReadingSchema.extend({ needId: text })).min(1).max(8),
  stats: z.strictObject({splits:z.number().int().nonnegative().max(7),singleReads:z.number().int().nonnegative().max(8)}).optional(),
});
export const loopAttemptSchema = z.strictObject({
  request: loopReadRequestSchema, examined: z.array(loopSourceSchema), findingIds: z.array(z.uuid()), note: text,
  readIssues: z.array(loopReadIssueSchema).min(1).optional(),
  batch: z.strictObject({ id: z.uuid(), needIds: z.array(text).min(1).max(8), splits:z.number().int().nonnegative().max(7).optional(), singleReads:z.number().int().nonnegative().max(8).optional() }).optional(),
});
export const loopAssessmentSchema = z.strictObject({
  needId: text, status: z.enum(['satisfied', 'unresolved', 'conflicting', 'not_applicable']),
  findingIds: z.array(z.uuid()), reason: text,
});
export const loopReviewSchema = z.strictObject({
  assessments: z.array(loopAssessmentSchema).min(1), nextRequests: z.array(loopReadRequestSchema),
  analysis: informationAnalysisSchema.optional(), professionalReview: savedProfessionalReviewSchema.optional(),
});
export const loopReviewInputSchema = z.strictObject({
  caseId: caseIdSchema, goal: text, round: z.number().int().positive(), needs: z.array(informationNeedSchema).min(1),
  findings: z.array(loopFindingSchema), attempts: z.array(loopAttemptSchema),
  sources: z.array(loopSourceSchema).optional(),
});
export const loopRoundSchema = z.strictObject({
  number: z.number().int().positive(), attempts: z.array(loopAttemptSchema).min(1), review: loopReviewSchema,
});
const capability = z.strictObject({ id: text, version: z.number().int().positive() });
export const loopProviderSchema = z.strictObject({ capability, pluginId: text, pluginVersion: text });
export const loopLimitsSchema = z.strictObject({
  maxRounds: z.number().int().min(1).max(20).default(4),
  maxReads: z.number().int().min(1).max(100).default(12),
});
export const loopRunSchema = z.strictObject({
  id: z.uuid(), caseId: caseIdSchema, baseCaseRevision: z.number().int().positive(), goal: text,
  createdAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  sources: z.array(loopSourceSchema).min(1),
  providers: z.strictObject({ declare: loopProviderSchema, read: loopProviderSchema, review: loopProviderSchema, readBatch: loopProviderSchema.optional() }),
  limits: loopLimitsSchema, needs: z.array(informationNeedSchema).min(1),
  findings: z.array(loopFindingSchema), rounds: z.array(loopRoundSchema),
  status: z.enum(['completed', 'needs_review', 'stalled', 'limit_reached']), reason: text,
  information: informationAnalysisSchema.optional(), professionalReview: savedProfessionalReviewSchema.optional(),
  metrics: z.strictObject({ modelCalls: z.number().int().nonnegative(), readBatches: z.number().int().nonnegative(), needSourceChecks: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative(), readingMode: z.enum(['per_need','batch']), batchSplits:z.number().int().nonnegative().optional(), singleNeedReads:z.number().int().nonnegative().optional() }).optional(),
});
export type LoopRun = z.infer<typeof loopRunSchema>;
export const loopStartSchema = z.strictObject({
  caseId: caseIdSchema, goal: text, sources: z.array(loopSourceSchema).min(1),
  declare: capability, read: capability, review: capability, readBatch: capability.optional(),
  readingMode: z.enum(['per_need', 'batch']).optional(),
  limits: loopLimitsSchema.default({ maxRounds: 4, maxReads: 12 }),
});
export type LoopStartInput = z.input<typeof loopStartSchema>;

/** A committed boundary after declaration, a complete read, or professional review. */
export const loopCheckpointSchema = z.strictObject({
  version: z.literal(1), runId: z.uuid(), request: loopStartSchema,
  sourceCaseRevision: z.number().int().positive(), createdAt: z.iso.datetime(),
  providers: loopRunSchema.shape.providers, declaration: loopDeclarationSchema,
  findings: z.array(loopFindingSchema), rounds: z.array(loopRoundSchema),
  pendingAttempts: z.array(loopAttemptSchema), requests: z.array(loopReadRequestSchema),
  outcome: z.strictObject({ status: loopRunSchema.shape.status, reason: text }).optional(),
});
export type LoopCheckpoint = z.infer<typeof loopCheckpointSchema>;
export const loopRunRequestSchema = z.strictObject({ caseId: caseIdSchema, runId: z.uuid() });
