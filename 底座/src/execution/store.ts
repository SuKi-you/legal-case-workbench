import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CaseError, CaseStore } from '../cases/store.ts';
import { caseIdSchema, type CaseWorkspaceState } from '../cases/contracts.ts';
import {
  executionSessionRequestSchema, executionSnapshotSchema, saveExecutionSnapshotSchema,
  type ExecutionSnapshot, type SaveExecutionSnapshotInput, type SavedExecutionSnapshot,
} from './contracts.ts';

type Entry = NonNullable<CaseWorkspaceState['executionSnapshots']>[number];
const MAX_BYTES = 8 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const active = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CaseError('EXECUTION_CANCELLED', 'Execution progress saving was cancelled before publication.');
};

async function readSnapshot(caseRoot: string, entry: Entry, caseId: string): Promise<ExecutionSnapshot> {
  const ids = executionSessionRequestSchema.parse({ caseId, sessionId: entry.sessionId });
  const snapshotId = caseIdSchema.parse(entry.snapshotId);
  const path = join(caseRoot, 'execution', ids.sessionId, `${snapshotId}.json`);
  let bytes: Buffer;
  try {
    if ((await stat(path)).size > MAX_BYTES) throw new CaseError('EXECUTION_SNAPSHOT_INVALID', 'Saved execution snapshot exceeds its size limit.');
    bytes = await readFile(path);
  } catch (error) {
    if (missing(error)) throw new CaseError('EXECUTION_SNAPSHOT_MISSING', 'A saved execution snapshot is missing.');
    throw error;
  }
  if (bytes.byteLength > MAX_BYTES || hash(bytes) !== entry.sha256) throw new CaseError('EXECUTION_SNAPSHOT_CHANGED', 'Saved execution snapshot differs from its committed checksum.');
  let snapshot: ExecutionSnapshot;
  try { snapshot = executionSnapshotSchema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch { throw new CaseError('EXECUTION_SNAPSHOT_INVALID', 'Saved execution snapshot does not satisfy its contract.'); }
  if (snapshot.id !== snapshotId || snapshot.caseId !== ids.caseId || snapshot.sessionId !== ids.sessionId) {
    throw new CaseError('EXECUTION_SNAPSHOT_INVALID', 'Snapshot identity differs from its case, session or filename.');
  }
  return snapshot;
}

/** Validate the complete active chain, independent of the current case view. */
async function readSession(caseRoot: string, caseId: string, sessionId: string, state: CaseWorkspaceState): Promise<ExecutionSnapshot[]> {
  const refs = (state.executionSnapshots ?? []).filter((entry) => entry.sessionId === sessionId);
  if (refs.length === 0) return [];
  if (new Set(refs.map((entry) => entry.snapshotId)).size !== refs.length) throw new CaseError('EXECUTION_SNAPSHOT_INVALID', 'Execution snapshot identities must be unique.');
  const snapshots: ExecutionSnapshot[] = [];
  for (const entry of refs) snapshots.push(await readSnapshot(caseRoot, entry, caseId));
  snapshots.sort((left, right) => left.sequence - right.sequence);
  for (const [index, snapshot] of snapshots.entries()) {
    const previous = snapshots[index - 1];
    if (snapshot.sequence !== index + 1 || snapshot.previousId !== (previous?.id ?? null)
      || (previous && Date.parse(snapshot.createdAt) < Date.parse(previous.createdAt))) {
      throw new CaseError('EXECUTION_SNAPSHOT_CHAIN_INVALID', 'Execution snapshots must form one complete ordered chain in the saved view.');
    }
  }
  return snapshots;
}

/** Used by full-case checkpoint validation against the checkpoint's own state. */
export async function validateSavedExecutionSnapshot(
  caseRoot: string, entry: Entry, caseId: string, state: CaseWorkspaceState,
): Promise<ExecutionSnapshot> {
  const sessionId = executionSessionRequestSchema.parse({ caseId, sessionId: entry.sessionId }).sessionId;
  if (!(state.executionSnapshots ?? []).some((saved) => saved.snapshotId === entry.snapshotId
    && saved.sessionId === sessionId && saved.sha256 === entry.sha256)) {
    throw new CaseError('EXECUTION_NOT_ACTIVE', 'Snapshot is outside the supplied case view.');
  }
  const chain = await readSession(caseRoot, caseId, sessionId, state);
  const snapshot = chain.find((saved) => saved.id === entry.snapshotId);
  if (!snapshot) throw new CaseError('EXECUTION_NOT_ACTIVE', 'Snapshot is outside the supplied case view.');
  return snapshot;
}

/** Immutable progress snapshots published only through the case's CAS journal. */
export class ExecutionStore {
  readonly #cases: CaseStore;
  constructor(dataDir: string, cases?: CaseStore) { this.#cases = cases ?? new CaseStore(resolve(dataDir)); }

  async save(input: SaveExecutionSnapshotInput, options: { signal?: AbortSignal } = {}): Promise<SavedExecutionSnapshot> {
    active(options.signal);
    const parsed = saveExecutionSnapshotSchema.parse(input);
    const current = await this.#cases.readState(parsed.caseId);
    if (current.record.revision !== parsed.expectedRevision) throw new CaseError('EXECUTION_STALE', 'Case changed before execution progress could be saved.');
    if (!current.workspace) throw new CaseError('CASE_WORKSPACE_UNINITIALIZED', 'Initialize legacy case materials before saving execution progress.');
    const state = structuredClone(current.workspace);
    const root = this.#cases.directory(parsed.caseId);
    const chain = await readSession(root, parsed.caseId, parsed.sessionId, state);
    const previous = chain.at(-1);
    if ((previous?.id ?? null) !== parsed.previousSnapshotId) throw new CaseError('EXECUTION_STALE', 'Execution progress changed; reopen the latest saved snapshot.');
    const snapshot = executionSnapshotSchema.parse({
      version: 1, id: randomUUID(), sessionId: parsed.sessionId, caseId: parsed.caseId,
      sequence: (previous?.sequence ?? 0) + 1, previousId: previous?.id ?? null,
      createdAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.createdAt) : 0)).toISOString(), payload: parsed.payload,
    });
    const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    if (bytes.byteLength > MAX_BYTES) throw new CaseError('EXECUTION_SNAPSHOT_INVALID', 'Execution progress exceeds the snapshot size limit.');
    active(options.signal);
    const directory = join(root, 'execution', parsed.sessionId);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `${snapshot.id}.${randomUUID()}.tmp`);
    let ownTemporary = false;
    try {
      const handle = await open(temporary, 'wx'); ownTemporary = true;
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      active(options.signal);
      await link(temporary, join(directory, `${snapshot.id}.json`));
    } finally { if (ownTemporary) await unlink(temporary).catch(() => {}); }
    state.executionSnapshots = [...(state.executionSnapshots ?? []), { sessionId: parsed.sessionId, snapshotId: snapshot.id, sha256: hash(bytes) }];
    active(options.signal);
    try {
      const saved = await this.#cases.commitWorkspace({ caseId: parsed.caseId, expectedRevision: parsed.expectedRevision,
        workspace: state, actor: '系统：Agent 执行进度', note: `保存会话 ${parsed.sessionId} 的第 ${snapshot.sequence} 个执行快照` }, options);
      return { snapshot, caseRevision: saved.revision };
    } catch (error) {
      if (error instanceof CaseError && error.code === 'CASE_REVISION_CONFLICT') {
        throw new CaseError('EXECUTION_STALE', 'Case changed before publication; staged progress is outside the current view.');
      }
      throw error;
    }
  }

  async loadLatest(input: { caseId: string; sessionId: string }): Promise<SavedExecutionSnapshot> {
    const parsed = executionSessionRequestSchema.parse(input);
    const current = await this.#cases.readState(parsed.caseId);
    const chain = current.workspace ? await readSession(this.#cases.directory(parsed.caseId), parsed.caseId, parsed.sessionId, current.workspace) : [];
    const snapshot = chain.at(-1);
    if (!snapshot) throw new CaseError('EXECUTION_NOT_ACTIVE', 'No such execution session in the selected case view.');
    return { snapshot, caseRevision: current.record.revision };
  }

  async list(caseId: string): Promise<SavedExecutionSnapshot[]> {
    const id = caseIdSchema.parse(caseId), current = await this.#cases.readState(id);
    const sessions = [...new Set((current.workspace?.executionSnapshots ?? []).map((entry) => entry.sessionId))];
    const saved: SavedExecutionSnapshot[] = [];
    for (const sessionId of sessions) {
      const chain = await readSession(this.#cases.directory(id), id, sessionId, current.workspace!);
      saved.push({ snapshot: chain.at(-1)!, caseRevision: current.record.revision });
    }
    return saved.sort((left, right) => right.snapshot.createdAt.localeCompare(left.snapshot.createdAt) || left.snapshot.sessionId.localeCompare(right.snapshot.sessionId));
  }
}
