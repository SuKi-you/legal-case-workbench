import { z } from 'zod';
import { loopCitationSchema, loopSourceSchema, type LoopRun, type LoopSource } from '../loops/contracts.ts';
import { informationConflictSchema, informationRecordSchema, needCoverageSchema } from '../information/contracts.ts';
import { savedProfessionalReviewSchema } from '../information/professional.ts';

const text = z.string().trim().min(1);
export const nodeReviewKindSchema = z.enum(['opponent_response', 'new_evidence', 'hearing_preparation']);
export type NodeReviewKind = z.infer<typeof nodeReviewKindSchema>;

const evidenceSchema = z.strictObject({
  findingId: z.uuid(),
  needId: text,
  statement: text,
  citations: z.array(loopCitationSchema).min(1),
  record: informationRecordSchema.optional(),
});
const coverageSchema = needCoverageSchema.pick({
  coverage: true, satisfaction: true, consistency: true, support: true,
  examined: true, unread: true, missingFields: true,
});
const conflictSchema = informationConflictSchema.pick({ classification: true, reason: true, field: true })
  .extend({ evidence: z.array(evidenceSchema).min(2) });
const professionalSchema = savedProfessionalReviewSchema.shape.assessments.element.omit({ findingIds: true })
  .extend({ evidence: z.array(evidenceSchema) });
export const nodePreparationSchema = z.strictObject({
  id: text.max(200),
  kind: z.enum(['read', 'clarify', 'human_review', 'prepare']),
  instruction: text,
  reason: text,
  needIds: z.array(text),
  currentFindingIds: z.array(z.uuid()),
  baselineFindingIds: z.array(z.uuid()),
  sources: z.array(loopSourceSchema),
});
export type NodePreparation = z.infer<typeof nodePreparationSchema>;
export const nodeReviewSchema = z.strictObject({
  version: z.literal(1),
  caseId: z.uuid(),
  kind: nodeReviewKindSchema,
  baselineRunId: z.uuid(),
  currentRunId: z.uuid(),
  status: z.enum(['requires_review', 'ready_for_review']),
  scope: z.strictObject({
    checked: z.boolean(),
    missingSources: z.array(loopSourceSchema),
    unexpectedSources: z.array(loopSourceSchema),
    unreadMaterialIds: z.array(z.uuid()).optional(),
    unparsedAttachmentIds: z.array(z.uuid()).optional(),
  }),
  sources: z.array(z.strictObject({
    materialId: z.uuid(),
    kind: z.enum(['added', 'version_changed', 'left_selection']),
    before: z.array(loopSourceSchema),
    after: z.array(loopSourceSchema),
    duplicateContent: z.array(loopSourceSchema),
  })),
  facts: z.array(z.strictObject({
    kind: z.enum(['new_record', 'evidence_changed', 'not_carried_forward']),
    needId: text,
    reason: text,
    before: z.array(evidenceSchema),
    after: z.array(evidenceSchema),
  })),
  coverage: z.array(z.strictObject({
    needId: text,
    question: text,
    definitionChanged: z.boolean(),
    before: coverageSchema.nullable(),
    after: coverageSchema.nullable(),
  })),
  conflicts: z.array(z.strictObject({
    kind: z.enum(['added', 'changed', 'not_carried_forward']),
    before: conflictSchema.nullable(),
    after: conflictSchema.nullable(),
  })),
  professional: z.strictObject({
    baselineReviewer: savedProfessionalReviewSchema.shape.reviewer.nullable(),
    currentReviewer: savedProfessionalReviewSchema.shape.reviewer.nullable(),
    baselineDecision: savedProfessionalReviewSchema.shape.decision.nullable(),
    currentDecision: savedProfessionalReviewSchema.shape.decision.nullable(),
    changes: z.array(z.strictObject({
      checkId: text,
      before: professionalSchema.nullable(),
      after: professionalSchema.nullable(),
    })),
  }),
  preparations: z.array(nodePreparationSchema),
});
export type NodeReview = z.infer<typeof nodeReviewSchema>;

export interface NodeReviewContributionInput {
  readonly kind: NodeReviewKind;
  readonly baseline: Readonly<LoopRun>;
  readonly current: Readonly<LoopRun>;
  readonly review: Readonly<NodeReview>;
}
export type NodeReviewContributor = (input: NodeReviewContributionInput) => readonly NodePreparation[];
export interface BuildNodeReviewInput {
  readonly kind: NodeReviewKind;
  readonly baseline: LoopRun;
  readonly current: LoopRun;
  /** The application supplies the material versions expected in the current case view. */
  readonly currentScope?: readonly LoopSource[];
  readonly unreadMaterialIds?: readonly string[];
  readonly unparsedAttachmentIds?: readonly string[];
  readonly contribute?: NodeReviewContributor;
}
