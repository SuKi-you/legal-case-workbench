import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  caseCheckpointSchema, caseEventSchema, caseIdSchema, caseRecordSchema, caseWorkspaceStateSchema,
  checkpointRequestSchema, createCaseSchema, createCheckpointSchema, listCasesSchema, updateCaseSchema,
  type CaseCheckpoint, type CaseEvent, type CaseList, type CaseRecord, type CaseState,
  type CaseWorkspaceState, type CreateCaseInput, type ListCasesInput, type RollbackResult, type UpdateCaseInput,
} from './contracts.ts';

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const exists = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'EEXIST';
const slot = (revision: number): string => `${String(revision).padStart(16, '0')}.json`;
const expectedRevisionSchema = caseRecordSchema.shape.revision;
const commitWorkspaceSchema = z.strictObject({
  caseId: caseIdSchema, expectedRevision: expectedRevisionSchema, workspace: caseWorkspaceStateSchema,
  actor: createCaseSchema.shape.actor, note: z.string().optional(),
});
const saveCheckpointSchema = createCheckpointSchema.extend({ expectedRevision: expectedRevisionSchema });
const restoreCheckpointSchema = checkpointRequestSchema.extend({
  expectedRevision: expectedRevisionSchema, actor: createCaseSchema.shape.actor, note: z.string().optional(),
});
const emptyWorkspace = (): CaseWorkspaceState => ({ materials: [], files: [] });
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const profile = (record: CaseRecord) => ({
  id: record.id, title: record.title, caseNumber: record.caseNumber, description: record.description,
  status: record.status, stage: record.stage, createdAt: record.createdAt,
});
const canonicalWorkspace = (workspace: CaseWorkspaceState) => ({
  materials: workspace.materials.map((material) => ({
    ...material,
    ocrAttemptIds: [...material.ocrAttemptIds].sort(),
    versions: [...material.versions].sort((a, b) => a.versionId.localeCompare(b.versionId)),
    referenceIds: [...material.referenceIds].sort(),
  })).sort((a, b) => a.materialId.localeCompare(b.materialId)),
  files: [...workspace.files].sort((a, b) => a.fileId.localeCompare(b.fileId)),
  loopRuns: [...(workspace.loopRuns ?? [])].sort((a, b) => a.runId.localeCompare(b.runId)),
  executionSnapshots: [...(workspace.executionSnapshots ?? [])].sort((a, b) => a.snapshotId.localeCompare(b.snapshotId)),
  outputs: [...(workspace.outputs ?? [])].sort((a, b) => a.outputId.localeCompare(b.outputId)),
});
const sameWorkspace = (left: CaseWorkspaceState | undefined, right: CaseWorkspaceState | undefined): boolean => (
  left === undefined || right === undefined ? left === right : same(canonicalWorkspace(left), canonicalWorkspace(right))
);

export class CaseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CaseError';
    this.code = code;
  }
}

/** Independent case profiles with immutable progress history, not a legal task engine. */
export class CaseStore {
  readonly #root: string;

  constructor(dataDir: string) {
    this.#root = join(resolve(dataDir), 'cases');
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  /** Callers must read the case before using this path for case-scoped resources. */
  directory(caseId: string): string {
    return join(this.#root, caseIdSchema.parse(caseId).toLowerCase());
  }

  async create(input: CreateCaseInput): Promise<CaseRecord> {
    const parsed = createCaseSchema.parse(input);
    await this.initialize();
    const id = randomUUID();
    const now = new Date().toISOString();
    const record = caseRecordSchema.parse({
      id, title: parsed.title, caseNumber: parsed.caseNumber ?? null,
      description: parsed.description ?? '', status: 'active', stage: parsed.stage ?? '待整理',
      revision: 1, createdAt: now, updatedAt: now,
    });
    const event = caseEventSchema.parse({
      id: randomUUID(), caseId: id, revision: 1, parentId: null, kind: 'created',
      at: now, actor: parsed.actor, record, workspace: emptyWorkspace(),
    });
    // The first committed event makes this case visible; an interrupted create
    // may leave an empty directory, which is not advertised as a usable case.
    await mkdir(this.directory(id));
    await mkdir(join(this.directory(id), 'revisions'));
    await this.#publish(event);
    return record;
  }

  async list(input: ListCasesInput = {}): Promise<CaseList> {
    const parsed = listCasesSchema.parse(input);
    let entries;
    try { entries = await readdir(this.#root, { withFileTypes: true }); }
    catch (error) {
      if (missing(error)) return { cases: [], unavailable: [] };
      throw error;
    }
    const cases: CaseRecord[] = [];
    const unavailable: CaseList['unavailable'] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !caseIdSchema.safeParse(entry.name).success) continue;
      try {
        const record = await this.read(entry.name);
        const query = parsed.query?.trim().toLowerCase() ?? '';
        const searchable = [record.title, record.caseNumber ?? '', record.description, record.stage].join('\n').toLowerCase();
        if ((!parsed.status || record.status === parsed.status) && (!query || searchable.includes(query))) cases.push(record);
      } catch (error) {
        if (error instanceof CaseError && error.code === 'CASE_NOT_FOUND') continue;
        unavailable.push({ caseId: entry.name, reason: error instanceof Error ? error.message : 'Cannot read this case.' });
      }
    }
    cases.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id));
    return { cases, unavailable };
  }

  async read(caseId: string): Promise<CaseRecord> {
    const events = await this.history(caseId);
    return events[events.length - 1]!.record;
  }

  async readState(caseId: string): Promise<CaseState> {
    const events = await this.history(caseId);
    const latest = events[events.length - 1]!;
    return { record: latest.record, ...(latest.workspace === undefined ? {} : { workspace: latest.workspace }) };
  }

  /** Publish immutable resource state in the same CAS journal as profile changes. */
  async commitWorkspace(input: {
    caseId: string; expectedRevision: number; workspace: CaseWorkspaceState; actor: string; note?: string;
  }, options: { signal?: AbortSignal } = {}): Promise<CaseRecord> {
    const parsed = commitWorkspaceSchema.parse(input);
    const previous = this.#expected(await this.history(parsed.caseId), parsed.expectedRevision);
    this.#validateWorkspace(parsed.workspace);
    if (previous.workspace !== undefined) this.#validateAppend(previous.workspace, parsed.workspace);
    const event = caseEventSchema.parse({
      ...this.#next(previous, parsed.actor),
      kind: previous.workspace === undefined ? 'workspace_initialized' : 'workspace_updated',
      workspace: parsed.workspace,
      ...(parsed.note === undefined ? {} : { note: parsed.note }),
    });
    await this.#publish(event, options.signal);
    return event.record;
  }

  async createCheckpoint(input: {
    caseId: string; expectedRevision: number; label: string; actor: string;
  }): Promise<CaseCheckpoint> {
    const parsed = saveCheckpointSchema.parse(input);
    const previous = this.#expected(await this.history(parsed.caseId), parsed.expectedRevision);
    const next = this.#next(previous, parsed.actor);
    const checkpoint = this.#checkpoint(previous, parsed.label, parsed.actor, next.at, false);
    const event = caseEventSchema.parse({ ...next, kind: 'checkpoint_created', checkpoint });
    await this.#publish(event);
    return checkpoint;
  }

  async listCheckpoints(caseId: string): Promise<CaseCheckpoint[]> {
    return this.#checkpoints(await this.history(caseId));
  }

  async getCheckpoint(input: { caseId: string; checkpointId: string }): Promise<CaseCheckpoint> {
    const parsed = checkpointRequestSchema.parse(input);
    const checkpoint = this.#checkpoints(await this.history(parsed.caseId)).find((item) => item.id === parsed.checkpointId);
    if (!checkpoint) throw new CaseError('CASE_CHECKPOINT_NOT_FOUND', 'No such checkpoint in the selected case.');
    return checkpoint;
  }

  /** One published event restores state and preserves the complete pre-rollback state. */
  async restoreCheckpoint(input: {
    caseId: string; checkpointId: string; expectedRevision: number; actor: string; note?: string;
  }): Promise<RollbackResult> {
    const parsed = restoreCheckpointSchema.parse(input);
    const events = await this.history(parsed.caseId);
    const previous = this.#expected(events, parsed.expectedRevision);
    const checkpoint = this.#checkpoints(events).find((item) => item.id === parsed.checkpointId);
    if (!checkpoint) throw new CaseError('CASE_CHECKPOINT_NOT_FOUND', 'No such checkpoint in the selected case.');
    const next = this.#next(previous, parsed.actor);
    const undoCheckpoint = this.#checkpoint(previous, '回滚前自动保存点', parsed.actor, next.at, true);
    const event = caseEventSchema.parse({
      ...next, kind: 'rolled_back',
      record: { ...checkpoint.record, revision: next.revision, updatedAt: next.at },
      workspace: checkpoint.workspace, restoredCheckpointId: checkpoint.id, undoCheckpoint,
      ...(parsed.note === undefined ? {} : { note: parsed.note }),
    });
    await this.#publish(event);
    return { case: event.record, restoredCheckpoint: checkpoint, undoCheckpoint };
  }

  async update(input: UpdateCaseInput): Promise<CaseRecord> {
    const parsed = updateCaseSchema.parse(input);
    const events = await this.history(parsed.caseId);
    const previous = events[events.length - 1]!;
    if (previous.revision !== parsed.expectedRevision || previous.revision === Number.MAX_SAFE_INTEGER) {
      throw new CaseError('CASE_REVISION_CONFLICT', 'Case progress has changed; read it again before saving.');
    }
    // Sequence numbers establish order even when two updates share a timestamp
    // or the local system clock moves backwards.
    const at = new Date(Math.max(Date.now(), Date.parse(previous.at))).toISOString();
    const record = caseRecordSchema.parse({
      ...previous.record,
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      ...(parsed.caseNumber === undefined ? {} : { caseNumber: parsed.caseNumber }),
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.stage === undefined ? {} : { stage: parsed.stage }),
      revision: previous.revision + 1, updatedAt: at,
    });
    const event = caseEventSchema.parse({
      id: randomUUID(), caseId: record.id, revision: record.revision, parentId: previous.id,
      kind: 'updated', at, actor: parsed.actor, record,
      ...(previous.workspace === undefined ? {} : { workspace: previous.workspace }),
      ...(parsed.note === undefined ? {} : { note: parsed.note }),
    });
    await this.#publish(event);
    return record;
  }

  async history(caseId: string): Promise<CaseEvent[]> {
    const id = caseIdSchema.parse(caseId).toLowerCase();
    const directory = join(this.directory(id), 'revisions');
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) {
      if (missing(error)) throw new CaseError('CASE_NOT_FOUND', `No saved case ${id}.`);
      throw error;
    }
    // Fix the committed file set before reading. Concurrent appends are either
    // included in this snapshot or observed by the caller's next read.
    const committed = files.filter((file) => file.endsWith('.json')).sort();
    if (committed.length === 0) throw new CaseError('CASE_NOT_FOUND', `No saved case ${id}.`);
    const events: CaseEvent[] = [];
    const eventIds = new Set<string>();
    const checkpoints = new Map<string, CaseCheckpoint>();
    for (const [index, file] of committed.entries()) {
      if (file !== slot(index + 1)) throw new CaseError('CASE_RECORD_INVALID', 'Case history slots are not consecutive.');
      let event: CaseEvent;
      try { event = caseEventSchema.parse(JSON.parse(await readFile(join(directory, file), 'utf8'))); }
      catch { throw new CaseError('CASE_RECORD_INVALID', `Cannot read valid case history ${file}.`); }
      const previous = events[events.length - 1];
      const record = event.record;
      if (event.caseId !== id || record.id !== id || event.revision !== index + 1 || record.revision !== event.revision
        || event.at !== record.updatedAt || eventIds.has(event.id)) {
        throw new CaseError('CASE_RECORD_INVALID', 'Case event identity, revision or timestamps do not match.');
      }
      if (!previous) {
        if (event.kind !== 'created' || event.parentId !== null || record.status !== 'active' || record.createdAt !== event.at) {
          throw new CaseError('CASE_RECORD_INVALID', 'The first case event is not a valid creation record.');
        }
        if (event.workspace !== undefined && !sameWorkspace(event.workspace, emptyWorkspace())) {
          throw new CaseError('CASE_RECORD_INVALID', 'New case creation cannot contain existing resources.');
        }
        this.#noCheckpointFields(event);
      } else if (event.kind === 'created' || event.parentId !== previous.id
        || record.createdAt !== previous.record.createdAt || Date.parse(event.at) < Date.parse(previous.at)) {
        throw new CaseError('CASE_RECORD_INVALID', 'Case history ancestry or creation date has changed.');
      }
      if (event.workspace !== undefined) this.#validateWorkspace(event.workspace);
      if (previous) this.#validateTransition(previous, event, checkpoints);
      eventIds.add(event.id);
      events.push(event);
    }
    return events;
  }

  #expected(events: CaseEvent[], revision: number): CaseEvent {
    const previous = events[events.length - 1]!;
    if (previous.revision !== revision || previous.revision === Number.MAX_SAFE_INTEGER) {
      throw new CaseError('CASE_REVISION_CONFLICT', 'Case state has changed; read it again before saving.');
    }
    return previous;
  }

  #next(previous: CaseEvent, actor: string): {
    id: string; caseId: string; revision: number; parentId: string; at: string;
    actor: string; record: CaseRecord; workspace?: CaseWorkspaceState;
  } {
    const at = new Date(Math.max(Date.now(), Date.parse(previous.at))).toISOString();
    return {
      id: randomUUID(), caseId: previous.caseId, revision: previous.revision + 1, parentId: previous.id, at, actor,
      record: { ...previous.record, revision: previous.revision + 1, updatedAt: at },
      ...(previous.workspace === undefined ? {} : { workspace: previous.workspace }),
    };
  }

  #checkpoint(previous: CaseEvent, label: string, actor: string, at: string, automatic: boolean): CaseCheckpoint {
    if (previous.workspace === undefined) {
      throw new CaseError('CASE_WORKSPACE_UNINITIALIZED', 'Initialize the legacy workspace before creating a checkpoint.');
    }
    return caseCheckpointSchema.parse({
      id: randomUUID(), caseId: previous.caseId, label, createdAt: at, actor,
      sourceRevision: previous.revision, automatic, record: previous.record, workspace: previous.workspace,
    });
  }

  #checkpoints(events: CaseEvent[]): CaseCheckpoint[] {
    return events.flatMap((event) => [
      ...(event.checkpoint ? [event.checkpoint] : []), ...(event.undoCheckpoint ? [event.undoCheckpoint] : []),
    ]);
  }

  #noCheckpointFields(event: CaseEvent): void {
    if (event.checkpoint !== undefined || event.undoCheckpoint !== undefined || event.restoredCheckpointId !== undefined) {
      throw new CaseError('CASE_RECORD_INVALID', 'Unexpected checkpoint data on this case event.');
    }
  }

  #validateTransition(previous: CaseEvent, event: CaseEvent, checkpoints: Map<string, CaseCheckpoint>): void {
    if (event.kind === 'updated') {
      this.#noCheckpointFields(event);
      if (!sameWorkspace(previous.workspace, event.workspace)) {
        throw new CaseError('CASE_RECORD_INVALID', 'A profile update changed its workspace resources.');
      }
      return;
    }
    if (event.kind === 'workspace_initialized' || event.kind === 'workspace_updated') {
      this.#noCheckpointFields(event);
      if (!same(profile(previous.record), profile(event.record)) || event.workspace === undefined) {
        throw new CaseError('CASE_RECORD_INVALID', 'A resource commit changed profile fields or omitted resource state.');
      }
      if (event.kind === 'workspace_initialized') {
        if (previous.workspace !== undefined) throw new CaseError('CASE_RECORD_INVALID', 'Workspace was initialized more than once.');
      } else {
        if (previous.workspace === undefined) throw new CaseError('CASE_RECORD_INVALID', 'Workspace update has no initialized base.');
        this.#validateAppend(previous.workspace, event.workspace);
      }
      return;
    }
    if (event.kind === 'checkpoint_created') {
      if (!same(profile(previous.record), profile(event.record)) || !sameWorkspace(previous.workspace, event.workspace)
        || !event.checkpoint || event.undoCheckpoint !== undefined || event.restoredCheckpointId !== undefined) {
        throw new CaseError('CASE_RECORD_INVALID', 'Checkpoint creation changed case data or has invalid fields.');
      }
      this.#validateCheckpoint(event.checkpoint, previous, event, false, checkpoints);
      checkpoints.set(event.checkpoint.id, event.checkpoint);
      return;
    }
    if (event.kind === 'rolled_back') {
      const target = event.restoredCheckpointId ? checkpoints.get(event.restoredCheckpointId) : undefined;
      if (!target || !event.undoCheckpoint || event.checkpoint !== undefined
        || !same(profile(event.record), profile(target.record)) || !sameWorkspace(event.workspace, target.workspace)) {
        throw new CaseError('CASE_RECORD_INVALID', 'Rollback does not match an existing checkpoint.');
      }
      this.#validateCheckpoint(event.undoCheckpoint, previous, event, true, checkpoints);
      checkpoints.set(event.undoCheckpoint.id, event.undoCheckpoint);
      return;
    }
    throw new CaseError('CASE_RECORD_INVALID', 'Unexpected case event kind.');
  }

  #validateCheckpoint(
    checkpoint: CaseCheckpoint, previous: CaseEvent, event: CaseEvent, automatic: boolean,
    checkpoints: Map<string, CaseCheckpoint>,
  ): void {
    if (checkpoint.caseId !== event.caseId || checkpoint.record.id !== event.caseId
      || checkpoint.sourceRevision !== previous.revision || !same(checkpoint.record, previous.record)
      || !sameWorkspace(checkpoint.workspace, previous.workspace) || checkpoint.createdAt !== event.at
      || checkpoint.actor !== event.actor || checkpoint.automatic !== automatic || checkpoints.has(checkpoint.id)) {
      throw new CaseError('CASE_RECORD_INVALID', 'Checkpoint identity or captured state does not match its source event.');
    }
  }

  #validateWorkspace(workspace: CaseWorkspaceState): void {
    const unique = (ids: string[]): boolean => new Set(ids).size === ids.length;
    if (!unique(workspace.materials.map((item) => item.materialId)) || !unique(workspace.files.map((item) => item.fileId))
      || !unique(workspace.materials.flatMap((item) => item.ocrAttemptIds))
      || !unique(workspace.materials.flatMap((item) => item.versions.map((version) => version.versionId)))
      || !unique(workspace.materials.flatMap((item) => item.referenceIds))
      || !unique((workspace.loopRuns ?? []).map((item) => item.runId))
      || !unique((workspace.executionSnapshots ?? []).map((item) => item.snapshotId))
      || !unique((workspace.outputs ?? []).map((item) => item.outputId))) {
      throw new CaseError('CASE_RECORD_INVALID', 'Workspace contains duplicate resource identities.');
    }
  }

  #validateAppend(before: CaseWorkspaceState, after: CaseWorkspaceState): void {
    const materials = new Map(after.materials.map((item) => [item.materialId, item]));
    const files = new Map(after.files.map((item) => [item.fileId, item]));
    const runs = new Map((after.loopRuns ?? []).map((item) => [item.runId, item.sha256]));
    const snapshots = new Map((after.executionSnapshots ?? []).map((item) => [item.snapshotId, item]));
    const outputs = new Map((after.outputs ?? []).map((item) => [item.outputId, item.sha256]));
    for (const old of before.materials) {
      const next = materials.get(old.materialId);
      const versions = new Map(next?.versions.map((item) => [item.versionId, item.textSha256]));
      if (!next || next.originalSha256 !== old.originalSha256
        || old.ocrAttemptIds.some((id) => !next.ocrAttemptIds.includes(id))
        || old.referenceIds.some((id) => !next.referenceIds.includes(id))
        || old.versions.some((item) => versions.get(item.versionId) !== item.textSha256)) {
        throw new CaseError('CASE_RECORD_INVALID', 'Ordinary workspace commits cannot remove or rewrite existing resources.');
      }
    }
    if (before.files.some((file) => files.get(file.fileId)?.sha256 !== file.sha256)) {
      throw new CaseError('CASE_RECORD_INVALID', 'Ordinary workspace commits cannot remove or rewrite existing files.');
    }
    if ((before.loopRuns ?? []).some((run) => runs.get(run.runId) !== run.sha256)) {
      throw new CaseError('CASE_RECORD_INVALID', 'Ordinary workspace commits cannot remove or rewrite existing loop runs.');
    }
    if ((before.executionSnapshots ?? []).some((snapshot) => snapshots.get(snapshot.snapshotId)?.sha256 !== snapshot.sha256
      || snapshots.get(snapshot.snapshotId)?.sessionId !== snapshot.sessionId)) {
      throw new CaseError('CASE_RECORD_INVALID', 'Ordinary workspace commits cannot remove or rewrite execution snapshots.');
    }
    if ((before.outputs ?? []).some((output) => outputs.get(output.outputId) !== output.sha256)) {
      throw new CaseError('CASE_RECORD_INVALID', 'Ordinary workspace commits cannot remove or rewrite saved outputs.');
    }
  }

  async #publish(event: CaseEvent, signal?: AbortSignal): Promise<void> {
    const directory = join(this.directory(event.caseId), 'revisions');
    const target = join(directory, slot(event.revision));
    const temporary = join(directory, `${randomUUID()}.tmp`);
    let ownTemporary = false;
    try {
      const handle = await open(temporary, 'wx');
      ownTemporary = true;
      try { await handle.writeFile(`${JSON.stringify(event, null, 2)}\n`); }
      finally { await handle.close(); }
      try {
        // Only one writer can claim the next revision, across separate processes
        // as well as separate instances; no shared mutable current-case pointer.
        // Once this atomic publish begins, its result decides whether it committed.
        if (signal?.aborted) throw new CaseError('CASE_OPERATION_CANCELLED', 'Case saving was cancelled before publication.');
        await link(temporary, target);
      } catch (error) {
        if (exists(error)) throw new CaseError('CASE_REVISION_CONFLICT', 'Another writer saved this revision first; read the case again.');
        throw error;
      }
    } finally {
      if (ownTemporary) await unlink(temporary).catch(() => {});
    }
  }
}
