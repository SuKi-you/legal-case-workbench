import { defineCapability, type PluginDefinition } from '../contracts.ts';
import { materialSchema, materialViewSchema, ocrAttemptSchema, type OcrAdapter } from '../materials/contracts.ts';
import {
  resolvedReferenceSchema, sourceReferenceSchema, textVersionSchema, textVersionsSchema, textVersionViewSchema,
} from '../materials/text-contracts.ts';
import {
  CASE_CAPABILITIES, caseContentsSchema, caseCreateReferenceSchema, caseFileRequestSchema, caseFileViewSchema,
  caseHistorySchema, caseListSchema, caseMaterialRequestSchema, caseRecordSchema, caseRegisterImageSchema,
  caseRegisterTextSchema, caseRequestSchema, caseResolveReferenceSchema, caseSaveRevisionSchema,
  caseVersionRequestSchema, createCaseSchema, exportCaseFileSchema, exportCaseMaterialSchema,
  exportedCaseFileSchema, importCaseFileSchema, listCasesSchema, storedCaseFileSchema, updateCaseSchema,
  applyRollbackSchema, caseCheckpointSchema, caseCheckpointsSchema, checkpointRequestSchema,
  createCheckpointSchema, rollbackPreviewSchema, rollbackResultSchema,
} from './contracts.ts';
import type { CaseStore } from './store.ts';
import type { CaseWorkspace } from './workspace.ts';
import type { CaseRollback } from './rollback.ts';

/** Case identity is explicit in every operation; no mutable 'current case' exists. */
export function createCasePlugin(cases: CaseStore, workspace: CaseWorkspace, ocr: OcrAdapter, rollback?: CaseRollback): PluginDefinition {
  const success = <T>(data: T) => ({ status: 'success' as const, data });
  return {
    manifest: { id: 'builtin.cases', version: '0.2.0', apiVersion: 1 },
    setup: async () => { await cases.initialize(); },
    capabilities: [
      defineCapability({ ...CASE_CAPABILITIES.create, input: createCaseSchema, output: caseRecordSchema,
        execute: async (input) => success(await cases.create(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.list, input: listCasesSchema, output: caseListSchema,
        execute: async (input) => success(await cases.list(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.read, input: caseRequestSchema, output: caseRecordSchema,
        execute: async ({ caseId }) => success(await cases.read(caseId)) }),
      defineCapability({ ...CASE_CAPABILITIES.update, input: updateCaseSchema, output: caseRecordSchema,
        execute: async (input) => success(await cases.update(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.history, input: caseRequestSchema, output: caseHistorySchema,
        execute: async ({ caseId }) => success(await cases.history(caseId)) }),
      defineCapability({ ...CASE_CAPABILITIES.contents, input: caseRequestSchema, output: caseContentsSchema,
        execute: async ({ caseId }) => success(await workspace.contents(caseId)) }),
      defineCapability({ ...CASE_CAPABILITIES.registerText, input: caseRegisterTextSchema, output: materialSchema,
        execute: async (input) => success(await workspace.registerText(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.registerImage, input: caseRegisterImageSchema, output: materialSchema,
        execute: async (input) => success(await workspace.registerImage(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.readMaterial, input: caseMaterialRequestSchema, output: materialViewSchema,
        execute: async (input) => success(await workspace.readMaterial(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.recognize, input: caseMaterialRequestSchema, output: ocrAttemptSchema,
        execute: async (input) => success(await workspace.recognize(input, ocr)) }),
      defineCapability({ ...CASE_CAPABILITIES.listVersions, input: caseMaterialRequestSchema, output: textVersionsSchema,
        execute: async (input) => success(await workspace.listVersions(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.readVersion, input: caseVersionRequestSchema, output: textVersionViewSchema,
        execute: async (input) => success(await workspace.readVersion(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.saveRevision, input: caseSaveRevisionSchema, output: textVersionSchema,
        execute: async (input) => success(await workspace.saveRevision(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.createReference, input: caseCreateReferenceSchema, output: sourceReferenceSchema,
        execute: async (input) => success(await workspace.createReference(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.resolveReference, input: caseResolveReferenceSchema, output: resolvedReferenceSchema,
        execute: async (input) => success(await workspace.resolveReference(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.importFile, input: importCaseFileSchema, output: storedCaseFileSchema,
        execute: async (input) => success(await workspace.importFile(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.readFile, input: caseFileRequestSchema, output: caseFileViewSchema,
        execute: async (input) => success(await workspace.readFile(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.exportFile, input: exportCaseFileSchema, output: exportedCaseFileSchema,
        execute: async (input) => success(await workspace.exportFile(input)) }),
      defineCapability({ ...CASE_CAPABILITIES.exportMaterial, input: exportCaseMaterialSchema, output: exportedCaseFileSchema,
        execute: async (input) => success(await workspace.exportMaterial(input)) }),
      ...(rollback ? [
        defineCapability({ ...CASE_CAPABILITIES.createCheckpoint, input: createCheckpointSchema, output: caseCheckpointSchema,
          execute: async (input) => success(await rollback.createCheckpoint(input)) }),
        defineCapability({ ...CASE_CAPABILITIES.listCheckpoints, input: caseRequestSchema, output: caseCheckpointsSchema,
          execute: async ({ caseId }) => success(await rollback.listCheckpoints(caseId)) }),
        defineCapability({ ...CASE_CAPABILITIES.previewRollback, input: checkpointRequestSchema, output: rollbackPreviewSchema,
          execute: async (input) => success(await rollback.preview(input)) }),
        defineCapability({ ...CASE_CAPABILITIES.applyRollback, input: applyRollbackSchema, output: rollbackResultSchema,
          execute: async (input) => success(await rollback.apply(input)) }),
      ] : []),
    ],
  };
}
