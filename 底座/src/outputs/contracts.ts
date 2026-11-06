import { z } from 'zod';
import { caseRecordSchema } from '../cases/contracts.ts';
import { informationNeedSchema, loopCitationSchema, loopFindingSchema, loopReadIssueSchema, loopSourceSchema } from '../loops/contracts.ts';
import { informationAnalysisSchema } from '../information/contracts.ts';
import { savedProfessionalReviewSchema } from '../information/professional.ts';
import { nodeReviewSchema } from '../node-review/contracts.ts';

const text = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const citedText = z.strictObject({ text: text.max(20000), findingIds: z.array(z.uuid()).min(1) });
export const outputSectionSchema = z.strictObject({
  id: text.max(100), title: text.max(200),
  provider: z.strictObject({ id: text.max(200), version: text.max(200) }),
  paragraphs: z.array(citedText).max(100).default([]),
  tables: z.array(z.strictObject({ title: text.max(200), columns: z.array(text.max(200)).min(1).max(12),
    rows: z.array(z.strictObject({ cells: z.array(text.max(2000)).min(1).max(12), findingIds: z.array(z.uuid()).min(1) })).max(200),
  })).max(20).default([]),
});
export type OutputSection = z.input<typeof outputSectionSchema>;
export const outputChangesSchema = z.strictObject({
  previousOutputId: z.uuid(), addedStatements: z.array(text), removedStatements: z.array(text),
  addedConflicts: z.array(text), removedConflicts: z.array(text),
  needChanges: z.array(z.strictObject({ needId: text, before: text.nullable(), after: text.nullable() })),
});
export const outputDraftSchema = z.strictObject({
  version: z.literal(1), outputId: z.uuid(), caseId: z.uuid(), runId: z.uuid(), createdAt: z.iso.datetime(),
  templateVersion: z.literal('fact-draft-1'), inputFingerprint: hash,
  case: caseRecordSchema, goal: text, runStatus: text, runReason: text,
  materials: z.array(z.strictObject({ materialId: z.uuid(), label: text, kind: text, originalSha256: hash,
    includedVersions: z.array(z.strictObject({ versionId: z.uuid(), textSha256: hash })),
    availableVersionIds: z.array(z.uuid()),
  })),
  attachments: z.array(z.strictObject({ fileId: z.uuid(), label: text, fileName: text, sha256: hash })),
  sources: z.array(loopSourceSchema), needs: z.array(informationNeedSchema), findings: z.array(loopFindingSchema),
  analysis: informationAnalysisSchema.nullable(),
  professionalReview: savedProfessionalReviewSchema.optional(),
  readIssues: z.array(loopReadIssueSchema.extend({ needId: text })).min(1).optional(),
  nodeReview: nodeReviewSchema.optional(),
  timeline: z.array(z.strictObject({ findingId: z.uuid(), start: text, end: text, precision: text })),
  uncertainTimeFindingIds: z.array(z.uuid()),
  references: z.array(z.strictObject({ id: text, findingId: z.uuid(), citation: loopCitationSchema })),
  sections: z.array(outputSectionSchema), changes: outputChangesSchema.nullable(),
});
export type OutputDraft = z.infer<typeof outputDraftSchema>;
export const outputManifestSchema = z.strictObject({
  version: z.literal(1), outputId: z.uuid(), caseId: z.uuid(), runId: z.uuid(), createdAt: z.iso.datetime(),
  templateVersion: z.literal('fact-draft-1'), inputFingerprint: hash, requestFingerprint: hash,
  previousOutputId: z.uuid().nullable(), sourceCaseRevision: z.number().int().positive(),
  sources: z.array(loopSourceSchema),
  files: z.strictObject({
    json: z.strictObject({ name: z.literal('draft.json'), sha256: hash, byteLength: z.number().int().nonnegative() }),
    md: z.strictObject({ name: z.literal('draft.md'), sha256: hash, byteLength: z.number().int().nonnegative() }),
    docx: z.strictObject({ name: z.literal('draft.docx'), sha256: hash, byteLength: z.number().int().nonnegative() }),
  }),
});
export type OutputManifest = z.infer<typeof outputManifestSchema>;
export type OutputFormat = keyof OutputManifest['files'];
