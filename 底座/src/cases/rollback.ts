import { createHash } from 'node:crypto';
import {
  applyRollbackSchema, caseCheckpointSchema, caseRequestSchema, caseWorkspaceStateSchema,
  checkpointRequestSchema, createCheckpointSchema, rollbackPreviewSchema, rollbackResultSchema,
  type ApplyRollbackInput, type CaseCheckpoint, type CaseRecord, type CaseWorkspaceState,
  type CreateCheckpointInput, type RollbackPreview, type RollbackResult,
} from './contracts.ts';
import { CaseError, type CaseStore } from './store.ts';
import type { CaseWorkspace } from './workspace.ts';

/** Resource inventories are sets, so ordering must not change a preview token. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Rollback state contains an unsupported JSON value.');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).sort().join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const excluded = new Set(right);
  return left.filter((id) => !excluded.has(id)).sort();
}

function versionDifference(left: CaseWorkspaceState, right: CaseWorkspaceState): RollbackPreview['versionsLeaving'] {
  const result: RollbackPreview['versionsLeaving'] = [];
  const excluded = new Map(right.materials.map((material) => [material.materialId, new Set(material.versions.map((version) => version.versionId))]));
  for (const material of left.materials) {
    for (const version of material.versions) {
      if (!excluded.get(material.materialId)?.has(version.versionId)) {
        result.push({ materialId: material.materialId, versionId: version.versionId });
      }
    }
  }
  return result.sort((a, b) => a.materialId.localeCompare(b.materialId) || a.versionId.localeCompare(b.versionId));
}

function referenceDifference(left: CaseWorkspaceState, right: CaseWorkspaceState): RollbackPreview['referencesLeaving'] {
  const result: RollbackPreview['referencesLeaving'] = [];
  const excluded = new Map(right.materials.map((material) => [material.materialId, new Set(material.referenceIds)]));
  for (const material of left.materials) {
    for (const referenceId of material.referenceIds) {
      if (!excluded.get(material.materialId)?.has(referenceId)) result.push({ materialId: material.materialId, referenceId });
    }
  }
  return result.sort((a, b) => a.materialId.localeCompare(b.materialId) || a.referenceId.localeCompare(b.referenceId));
}

function ocrDifference(left: CaseWorkspaceState, right: CaseWorkspaceState): RollbackPreview['ocrAttemptsLeaving'] {
  const result: RollbackPreview['ocrAttemptsLeaving'] = [];
  const excluded = new Map(right.materials.map((material) => [material.materialId, new Set(material.ocrAttemptIds)]));
  for (const material of left.materials) {
    for (const attemptId of material.ocrAttemptIds) {
      if (!excluded.get(material.materialId)?.has(attemptId)) result.push({ materialId: material.materialId, attemptId });
    }
  }
  return result.sort((a, b) => a.materialId.localeCompare(b.materialId) || a.attemptId.localeCompare(b.attemptId));
}

function fieldDifference(current: CaseRecord, target: CaseRecord): RollbackPreview['fields'] {
  const fields: RollbackPreview['fields'] = [];
  for (const field of ['title', 'caseNumber', 'description', 'status', 'stage'] as const) {
    if (current[field] !== target[field]) fields.push({ field, before: current[field], after: target[field] });
  }
  return fields;
}

/**
 * Restores a case's logical view by appending one journal event. Originals and
 * historical references are never rewritten or deleted by this service.
 */
export class CaseRollback {
  readonly #cases: CaseStore;
  readonly #workspace: CaseWorkspace;

  constructor(cases: CaseStore, workspace: CaseWorkspace) {
    this.#cases = cases;
    this.#workspace = workspace;
  }

  async createCheckpoint(input: CreateCheckpointInput): Promise<CaseCheckpoint> {
    const parsed = createCheckpointSchema.parse(input);
    const current = await this.#workspace.snapshotState(parsed.caseId);
    this.#checkCase(current.record, parsed.caseId);
    await this.#workspace.validateState(parsed.caseId, current.workspace);
    // CAS rejects any resource/profile save completed during validation.
    return caseCheckpointSchema.parse(await this.#cases.createCheckpoint({
      ...parsed, expectedRevision: current.record.revision,
    }));
  }

  async listCheckpoints(caseId: string): Promise<CaseCheckpoint[]> {
    const parsed = caseRequestSchema.parse({ caseId });
    return (await this.#cases.listCheckpoints(parsed.caseId)).map((checkpoint) => caseCheckpointSchema.parse(checkpoint));
  }

  async preview(input: { caseId: string; checkpointId: string }): Promise<RollbackPreview> {
    const parsed = checkpointRequestSchema.parse(input);
    const current = await this.#workspace.snapshotState(parsed.caseId);
    this.#checkCase(current.record, parsed.caseId);
    const checkpoint = caseCheckpointSchema.parse(await this.#cases.getCheckpoint(parsed));
    if (checkpoint.caseId !== parsed.caseId || checkpoint.record.id !== parsed.caseId) {
      throw new CaseError('CASE_RECORD_INVALID', 'Checkpoint does not belong to the selected case.');
    }
    const currentWorkspace = caseWorkspaceStateSchema.parse(current.workspace);
    const targetWorkspace = checkpoint.workspace;
    // A manifest alone cannot repair damaged originals. Validate all target
    // bytes and text identities before offering the state as a restoration.
    await this.#workspace.validateState(parsed.caseId, targetWorkspace);
    const token = createHash('sha256').update('law-agent/case-rollback-preview@1\n').update(canonicalJson({
      caseId: parsed.caseId, current: { record: current.record, workspace: currentWorkspace }, checkpoint,
    }), 'utf8').digest('hex');
    return rollbackPreviewSchema.parse({
      ...parsed, expectedRevision: current.record.revision, token,
      current: current.record, target: checkpoint.record,
      fields: fieldDifference(current.record, checkpoint.record),
      materialsLeaving: difference(currentWorkspace.materials.map((entry) => entry.materialId), targetWorkspace.materials.map((entry) => entry.materialId)),
      materialsReturning: difference(targetWorkspace.materials.map((entry) => entry.materialId), currentWorkspace.materials.map((entry) => entry.materialId)),
      filesLeaving: difference(currentWorkspace.files.map((entry) => entry.fileId), targetWorkspace.files.map((entry) => entry.fileId)),
      filesReturning: difference(targetWorkspace.files.map((entry) => entry.fileId), currentWorkspace.files.map((entry) => entry.fileId)),
      loopRunsLeaving: difference((currentWorkspace.loopRuns ?? []).map((entry) => entry.runId), (targetWorkspace.loopRuns ?? []).map((entry) => entry.runId)),
      loopRunsReturning: difference((targetWorkspace.loopRuns ?? []).map((entry) => entry.runId), (currentWorkspace.loopRuns ?? []).map((entry) => entry.runId)),
      executionSnapshotsLeaving: difference((currentWorkspace.executionSnapshots ?? []).map((entry) => entry.snapshotId), (targetWorkspace.executionSnapshots ?? []).map((entry) => entry.snapshotId)),
      executionSnapshotsReturning: difference((targetWorkspace.executionSnapshots ?? []).map((entry) => entry.snapshotId), (currentWorkspace.executionSnapshots ?? []).map((entry) => entry.snapshotId)),
      outputsLeaving: difference((currentWorkspace.outputs ?? []).map((entry) => entry.outputId), (targetWorkspace.outputs ?? []).map((entry) => entry.outputId)),
      outputsReturning: difference((targetWorkspace.outputs ?? []).map((entry) => entry.outputId), (currentWorkspace.outputs ?? []).map((entry) => entry.outputId)),
      versionsLeaving: versionDifference(currentWorkspace, targetWorkspace),
      versionsReturning: versionDifference(targetWorkspace, currentWorkspace),
      referencesLeaving: referenceDifference(currentWorkspace, targetWorkspace),
      referencesReturning: referenceDifference(targetWorkspace, currentWorkspace),
      ocrAttemptsLeaving: ocrDifference(currentWorkspace, targetWorkspace),
      ocrAttemptsReturning: ocrDifference(targetWorkspace, currentWorkspace),
    });
  }

  async apply(input: ApplyRollbackInput): Promise<RollbackResult> {
    const parsed = applyRollbackSchema.parse(input);
    const preview = await this.preview({ caseId: parsed.caseId, checkpointId: parsed.checkpointId });
    if (preview.expectedRevision !== parsed.expectedRevision || preview.token !== parsed.previewToken) {
      throw new CaseError('CASE_ROLLBACK_STALE', 'Case contents or the selected checkpoint changed; preview the rollback again.');
    }
    try {
      return rollbackResultSchema.parse(await this.#cases.restoreCheckpoint({
        caseId: parsed.caseId, checkpointId: parsed.checkpointId, expectedRevision: parsed.expectedRevision,
        actor: parsed.actor, ...(parsed.note === undefined ? {} : { note: parsed.note }),
      }));
    } catch (error) {
      if (error instanceof CaseError && error.code === 'CASE_REVISION_CONFLICT') {
        throw new CaseError('CASE_ROLLBACK_STALE', 'Another save completed during rollback validation; preview again.');
      }
      throw error;
    }
  }

  #checkCase(record: CaseRecord, caseId: string): void {
    if (record.id !== caseId) throw new CaseError('CASE_RECORD_INVALID', 'Workspace belongs to a different case.');
  }
}
