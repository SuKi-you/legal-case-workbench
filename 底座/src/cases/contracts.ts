import { z } from 'zod';
import { materialSchema } from '../materials/contracts.ts';
import { createReferenceSchema, referenceRequestSchema, saveRevisionSchema } from '../materials/text-contracts.ts';

export const caseIdSchema = z.uuid().transform((id) => id.toLowerCase());
export const caseRequestSchema = z.strictObject({ caseId: caseIdSchema });
export const caseStatusSchema = z.enum(['active', 'paused', 'closed']);
const revisionNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const title = z.string().trim().min(1).max(200);
const stage = z.string().trim().min(1).max(100);
const actor = z.string().trim().min(1).max(100);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const workspaceMaterialStateSchema = z.strictObject({
  materialId: z.uuid(), originalSha256: sha256,
  ocrAttemptIds: z.array(z.uuid()),
  versions: z.array(z.strictObject({ versionId: z.uuid(), textSha256: sha256 })),
  referenceIds: z.array(z.uuid()),
});
export const caseWorkspaceStateSchema = z.strictObject({
  materials: z.array(workspaceMaterialStateSchema),
  files: z.array(z.strictObject({ fileId: z.uuid(), sha256 })),
  // Omitted by histories/checkpoints created before intake loops existed.
  loopRuns: z.array(z.strictObject({ runId: z.uuid(), sha256 })).optional(),
  executionSnapshots: z.array(z.strictObject({ sessionId: z.uuid(), snapshotId: z.uuid(), sha256 })).optional(),
  outputs: z.array(z.strictObject({ outputId: z.uuid(), sha256 })).optional(),
});
export type WorkspaceMaterialState = z.infer<typeof workspaceMaterialStateSchema>;
export type CaseWorkspaceState = z.infer<typeof caseWorkspaceStateSchema>;

export const caseRecordSchema = z.strictObject({
  id: caseIdSchema, title, caseNumber: z.string().trim().min(1).nullable(), description: z.string(),
  status: caseStatusSchema, stage, revision: revisionNumber,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type CaseRecord = z.infer<typeof caseRecordSchema>;
export const caseCheckpointSchema = z.strictObject({
  id: z.uuid(), caseId: caseIdSchema, label: z.string().trim().min(1).max(200),
  createdAt: z.iso.datetime(), actor, sourceRevision: revisionNumber,
  automatic: z.boolean(), record: caseRecordSchema, workspace: caseWorkspaceStateSchema,
});
export type CaseCheckpoint = z.infer<typeof caseCheckpointSchema>;
export const caseCheckpointsSchema = z.array(caseCheckpointSchema);
export const checkpointRequestSchema = caseRequestSchema.extend({ checkpointId: z.uuid() });
export const createCheckpointSchema = caseRequestSchema.extend({ label: z.string().trim().min(1).max(200), actor });
export type CreateCheckpointInput = z.infer<typeof createCheckpointSchema>;
export const rollbackPreviewSchema = z.strictObject({
  caseId: caseIdSchema, checkpointId: z.uuid(), expectedRevision: revisionNumber, token: sha256,
  current: caseRecordSchema, target: caseRecordSchema,
  fields: z.array(z.strictObject({ field: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
  materialsLeaving: z.array(z.uuid()), materialsReturning: z.array(z.uuid()),
  filesLeaving: z.array(z.uuid()), filesReturning: z.array(z.uuid()),
  loopRunsLeaving: z.array(z.uuid()), loopRunsReturning: z.array(z.uuid()),
  executionSnapshotsLeaving: z.array(z.uuid()).optional(), executionSnapshotsReturning: z.array(z.uuid()).optional(),
  outputsLeaving: z.array(z.uuid()).optional(), outputsReturning: z.array(z.uuid()).optional(),
  ocrAttemptsLeaving: z.array(z.strictObject({ materialId: z.uuid(), attemptId: z.uuid() })),
  ocrAttemptsReturning: z.array(z.strictObject({ materialId: z.uuid(), attemptId: z.uuid() })),
  versionsLeaving: z.array(z.strictObject({ materialId: z.uuid(), versionId: z.uuid() })),
  versionsReturning: z.array(z.strictObject({ materialId: z.uuid(), versionId: z.uuid() })),
  referencesLeaving: z.array(z.strictObject({ materialId: z.uuid(), referenceId: z.uuid() })),
  referencesReturning: z.array(z.strictObject({ materialId: z.uuid(), referenceId: z.uuid() })),
});
export type RollbackPreview = z.infer<typeof rollbackPreviewSchema>;
export const applyRollbackSchema = checkpointRequestSchema.extend({
  expectedRevision: revisionNumber, previewToken: sha256, actor, note: z.string().optional(),
});
export type ApplyRollbackInput = z.infer<typeof applyRollbackSchema>;
export const rollbackResultSchema = z.strictObject({
  case: caseRecordSchema, restoredCheckpoint: caseCheckpointSchema, undoCheckpoint: caseCheckpointSchema,
});
export type RollbackResult = z.infer<typeof rollbackResultSchema>;
export const caseStateSchema = z.strictObject({
  record: caseRecordSchema, workspace: caseWorkspaceStateSchema.optional(),
});
export type CaseState = z.infer<typeof caseStateSchema>;
export const createCaseSchema = z.strictObject({
  title, caseNumber: z.string().trim().min(1).optional(), description: z.string().optional(),
  stage: stage.optional(), actor,
});
export type CreateCaseInput = z.infer<typeof createCaseSchema>;
export const listCasesSchema = z.strictObject({ query: z.string().optional(), status: caseStatusSchema.optional() });
export type ListCasesInput = z.infer<typeof listCasesSchema>;
export const caseListSchema = z.strictObject({
  cases: z.array(caseRecordSchema),
  unavailable: z.array(z.strictObject({ caseId: caseIdSchema, reason: z.string() })),
});
export type CaseList = z.infer<typeof caseListSchema>;
export const updateCaseSchema = z.strictObject({
  caseId: caseIdSchema, expectedRevision: revisionNumber, actor,
  title: title.optional(), caseNumber: z.string().trim().min(1).nullable().optional(),
  description: z.string().optional(), status: caseStatusSchema.optional(), stage: stage.optional(),
  note: z.string().optional(),
}).refine((input) => ['title', 'caseNumber', 'description', 'status', 'stage'].some((field) => (
  Object.prototype.hasOwnProperty.call(input, field)
)), 'Provide at least one case field to update');
export type UpdateCaseInput = z.infer<typeof updateCaseSchema>;
export const caseEventSchema = z.strictObject({
  id: z.uuid(), caseId: caseIdSchema, revision: revisionNumber, parentId: z.uuid().nullable(),
  kind: z.enum(['created', 'updated', 'workspace_initialized', 'workspace_updated', 'checkpoint_created', 'rolled_back']),
  at: z.iso.datetime(), actor, note: z.string().optional(),
  record: caseRecordSchema,
  workspace: caseWorkspaceStateSchema.optional(),
  checkpoint: caseCheckpointSchema.optional(), undoCheckpoint: caseCheckpointSchema.optional(),
  restoredCheckpointId: z.uuid().optional(),
});
export type CaseEvent = z.infer<typeof caseEventSchema>;
export const caseHistorySchema = z.array(caseEventSchema);

export const caseRegisterTextSchema = z.strictObject({
  caseId: caseIdSchema, sourceLabel: z.string().trim().min(1),
  text: z.string().refine((value) => value.trim().length > 0, 'Text must not be blank'),
});
export const caseRegisterImageSchema = z.strictObject({
  caseId: caseIdSchema, sourceLabel: z.string().trim().min(1), path: z.string().min(1),
});
export const caseMaterialRequestSchema = caseRequestSchema.extend({ materialId: z.uuid() });
export const caseVersionRequestSchema = caseMaterialRequestSchema.extend({ versionId: z.uuid() });
export const caseSaveRevisionSchema = saveRevisionSchema.extend({ caseId: caseIdSchema });
export const caseCreateReferenceSchema = createReferenceSchema.safeExtend({ caseId: caseIdSchema });
export const caseResolveReferenceSchema = referenceRequestSchema.extend({ caseId: caseIdSchema });

export const storedCaseFileSchema = z.strictObject({
  id: z.uuid(), caseId: caseIdSchema, fileName: z.string().min(1), sourceLabel: z.string().trim().min(1),
  createdAt: z.iso.datetime(), byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type StoredCaseFile = z.infer<typeof storedCaseFileSchema>;
export const importCaseFileSchema = z.strictObject({
  caseId: caseIdSchema, path: z.string().min(1), sourceLabel: z.string().trim().min(1),
});
export type ImportCaseFileInput = z.infer<typeof importCaseFileSchema>;
export const caseFileRequestSchema = caseRequestSchema.extend({ fileId: z.uuid() });
export type CaseFileRequest = z.infer<typeof caseFileRequestSchema>;
export const caseFileViewSchema = z.strictObject({ file: storedCaseFileSchema, originalPath: z.string() });
export type CaseFileView = z.infer<typeof caseFileViewSchema>;
export const exportCaseFileSchema = caseFileRequestSchema.extend({ destination: z.string().min(1) });
export type ExportCaseFileInput = z.infer<typeof exportCaseFileSchema>;
export const exportCaseMaterialSchema = caseMaterialRequestSchema.extend({ destination: z.string().min(1) });
export const exportedCaseFileSchema = z.strictObject({ destination: z.string(), sha256: z.string() });
export type ExportedCaseFile = z.infer<typeof exportedCaseFileSchema>;
export const caseContentsSchema = z.strictObject({
  case: caseRecordSchema, materials: z.array(materialSchema), files: z.array(storedCaseFileSchema),
});
export type CaseContents = z.infer<typeof caseContentsSchema>;

export const CASE_CAPABILITIES = Object.freeze({
  create: { id: 'cases.create', version: 1 },
  list: { id: 'cases.list', version: 1 },
  read: { id: 'cases.read', version: 1 },
  update: { id: 'cases.update', version: 1 },
  history: { id: 'cases.history', version: 1 },
  contents: { id: 'cases.contents', version: 1 },
  registerText: { id: 'cases.register-text', version: 1 },
  registerImage: { id: 'cases.register-image', version: 1 },
  readMaterial: { id: 'cases.read-material', version: 1 },
  recognize: { id: 'cases.recognize', version: 1 },
  listVersions: { id: 'cases.list-text-versions', version: 1 },
  readVersion: { id: 'cases.read-text-version', version: 1 },
  saveRevision: { id: 'cases.save-text-revision', version: 1 },
  createReference: { id: 'cases.create-reference', version: 1 },
  resolveReference: { id: 'cases.resolve-reference', version: 1 },
  importFile: { id: 'cases.import-file', version: 1 },
  readFile: { id: 'cases.read-file', version: 1 },
  exportFile: { id: 'cases.export-file', version: 1 },
  exportMaterial: { id: 'cases.export-material', version: 1 },
  createCheckpoint: { id: 'cases.create-checkpoint', version: 1 },
  listCheckpoints: { id: 'cases.list-checkpoints', version: 1 },
  previewRollback: { id: 'cases.preview-rollback', version: 1 },
  applyRollback: { id: 'cases.apply-rollback', version: 1 },
});

