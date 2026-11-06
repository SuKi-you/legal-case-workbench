import { z } from 'zod';
import { informationSourceSchema, type InformationAnalysis, type StructuredNeed } from './contracts.ts';
import type { LoopFinding, LoopSource, LoopRun } from '../loops/contracts.ts';
import { InformationError } from './errors.ts';

const text = z.string().trim().min(1);
export const professionalReviewSchema = z.strictObject({
  assessments: z
    .array(
      z.strictObject({
        checkId: text,
        state: z.enum(['supported', 'opposed', 'unresolved', 'conflicting', 'not_applicable']),
        findingIds: z.array(z.uuid()),
        reason: text,
      }),
    )
    .min(1),
  actions: z.array(
    z.strictObject({
      kind: z.enum(['read', 'clarify', 'human_review']),
      checkId: text,
      needId: text,
      reason: text,
      instruction: text,
      sources: z.array(informationSourceSchema).min(1).optional(),
    }),
  ),
  decision: z.enum(['ready', 'continue', 'needs_input', 'human_review']),
});
export type ProfessionalReview = z.infer<typeof professionalReviewSchema>;
export const savedProfessionalReviewSchema = professionalReviewSchema.extend({
  reviewer: z.strictObject({ id: text, version: text, profileId: text }),
});
export type SavedProfessionalReview = z.infer<typeof savedProfessionalReviewSchema>;
export interface ProfessionalReviewInput {
  caseId: string;
  goal: string;
  needs: readonly StructuredNeed[];
  findings: readonly LoopFinding[];
  analysis: InformationAnalysis;
  sources: readonly LoopSource[];
  attempts: readonly LoopRun['rounds'][number]['attempts'][number][];
}
export interface ProfessionalReviewer {
  readonly id: string;
  readonly version: string;
  readonly profileId: string;
  review(input: ProfessionalReviewInput): ProfessionalReview | Promise<ProfessionalReview>;
}
const sourceKey = (source: LoopSource) => `${source.materialId}/${source.versionId}/${source.textSha256}`;
/** This validates the professional protocol, not the correctness of a legal rule. */
export function validateProfessionalReview(
  review: ProfessionalReview,
  input: Pick<ProfessionalReviewInput, 'needs' | 'findings' | 'sources'>,
): void {
  const fail = (reason: string): never => {
    throw new InformationError('PROFESSIONAL_REVIEW_INVALID', reason);
  };
  const findings = new Set(input.findings.map((item) => item.id));
  const needs = new Set(input.needs.map((item) => item.id));
  const sources = new Set(input.sources.map(sourceKey));
  const checks = new Set<string>();
  for (const item of review.assessments) {
    if (checks.has(item.checkId)) fail('Professional check IDs must be unique.');
    checks.add(item.checkId);
    if (new Set(item.findingIds).size !== item.findingIds.length || item.findingIds.some((id) => !findings.has(id)))
      fail('A professional check cites missing or duplicate records.');
    if (['supported', 'opposed', 'conflicting'].includes(item.state) && item.findingIds.length === 0)
      fail('A professional claim requires source-backed records.');
  }
  for (const action of review.actions) {
    if (!checks.has(action.checkId) || !needs.has(action.needId))
      fail('A professional action refers to an unknown check or need.');
    if (
      action.sources &&
      (new Set(action.sources.map(sourceKey)).size !== action.sources.length ||
        action.sources.some((source) => !sources.has(sourceKey(source))))
    )
      fail('A professional action targets sources outside this run.');
  }
  if (
    review.decision === 'ready' &&
    (review.actions.length > 0 || review.assessments.some((item) => ['unresolved', 'conflicting'].includes(item.state)))
  )
    fail('Ready cannot hide pending professional checks or actions.');
  if (review.decision === 'continue' && !review.actions.some((action) => action.kind === 'read'))
    fail('Continue requires a specific read action.');
  if (review.decision === 'needs_input' && !review.actions.some((action) => action.kind === 'clarify'))
    fail('Needs-input requires a specific clarification.');
  if (review.decision === 'human_review' && !review.actions.some((action) => action.kind === 'human_review'))
    fail('Human-review requires a specific review action.');
}
