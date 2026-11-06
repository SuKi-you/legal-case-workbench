import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { materialIdSchema, type Material, type MaterialView, type OcrAdapter, type OcrAttempt } from '../materials/contracts.ts';
import { MaterialStore } from '../materials/store.ts';
import { MaterialTextStore } from '../materials/versions.ts';
import { SourceReferenceStore } from '../materials/references.ts';
import { validateSavedLoopRun } from '../loops/store.ts';
import { validateSavedExecutionSnapshot } from '../execution/store.ts';
import type { CreateReferenceInput, ReferenceRequest, ResolvedReference, SaveRevisionInput, SourceReference, TextRevision, TextVersion, TextVersionView } from '../materials/text-contracts.ts';
import {
  caseContentsSchema, caseFileRequestSchema, caseIdSchema, caseMaterialRequestSchema,
  caseRegisterImageSchema, caseRegisterTextSchema, caseSaveRevisionSchema,
  caseCreateReferenceSchema, caseResolveReferenceSchema, caseVersionRequestSchema,
  caseWorkspaceStateSchema,
  exportCaseFileSchema, exportCaseMaterialSchema, importCaseFileSchema, storedCaseFileSchema,
  type CaseContents, type CaseFileRequest, type CaseFileView, type ExportCaseFileInput,
  type ExportedCaseFile, type ImportCaseFileInput, type StoredCaseFile,
  type CaseRecord, type CaseWorkspaceState, type WorkspaceMaterialState,
} from './contracts.ts';
import { CaseError, CaseStore } from './store.ts';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
type Scope = {
  caseId: string; root: string; materials: MaterialStore; texts: MaterialTextStore; references: SourceReferenceStore;
};

/** An initial revision fence rejected the call before its resource write started. */
export class CaseWriteStaleError extends CaseError {
  constructor() {
    super('CASE_REVISION_CONFLICT', 'Case changed since this action was prepared; reopen it before starting the write.');
    this.name = 'CaseWriteStaleError';
  }
}

async function physicalLocation(path: string): Promise<string> {
  let ancestor = resolve(path);
  const tail: string[] = [];
  while (true) {
    try { return resolve(await realpath(ancestor), ...tail.reverse()); }
    catch (error) {
      if (!missing(error)) throw error;
      tail.push(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

/** A local project-like workspace. Every operation selects a case explicitly. */
export class CaseWorkspace {
  readonly #dataDir: string;
  readonly #cases: CaseStore;

  constructor(dataDir: string, cases?: CaseStore) {
    this.#dataDir = resolve(dataDir);
    this.#cases = cases ?? new CaseStore(dataDir);
  }

  async contents(caseId: string): Promise<CaseContents> {
    const scope = await this.#scope(caseId);
    const snapshot = await this.#snapshot(scope);
    const materials: Material[] = [];
    for (const entry of snapshot.workspace.materials) {
      const view = await this.#material(scope, entry.materialId);
      this.#checkOriginal(entry, view);
      materials.push(view.material);
    }
    const files: StoredCaseFile[] = [];
    for (const entry of snapshot.workspace.files) {
      const stored = await this.#file(scope, entry.fileId);
      if (stored.view.file.sha256 !== entry.sha256) throw new CaseError('CASE_FILE_CHANGED', 'File differs from the saved case state.');
      files.push(stored.view.file);
    }
    materials.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    files.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return caseContentsSchema.parse({ case: snapshot.record, materials, files });
  }

  /** A committed logical view; legacy cases receive a one-time inventory initialization. */
  async snapshotState(caseId: string): Promise<{ record: CaseRecord; workspace: CaseWorkspaceState }> {
    return this.#snapshot(await this.#scope(caseId));
  }

  /** Validate a checkpoint without changing or deleting its immutable source files. */
  async validateState(caseId: string, input: CaseWorkspaceState): Promise<void> {
    const scope = await this.#scope(caseId);
    const state = caseWorkspaceStateSchema.parse(input);
    for (const entry of state.materials) {
      const view = await this.#material(scope, entry.materialId);
      this.#checkOriginal(entry, view);
      for (const attemptId of entry.ocrAttemptIds) {
        if (!view.ocrAttempts.some((attempt) => attempt.id === attemptId)) {
          throw new CaseError('CASE_STATE_INVALID', 'Saved OCR record is missing.');
        }
      }
      for (const expected of entry.versions) {
        const { version } = await scope.texts.readVersion({ materialId: entry.materialId, versionId: expected.versionId });
        if (version.textSha256 !== expected.textSha256) throw new CaseError('CASE_VERSION_CHANGED', 'Saved text version checksum differs.');
      }
      for (const referenceId of entry.referenceIds) {
        const reference = await scope.references.resolve({ materialId: entry.materialId, referenceId });
        if (!entry.versions.some((version) => version.versionId === reference.version.id)) {
          throw new CaseError('CASE_STATE_INVALID', 'Checkpoint reference is outside its saved text versions.');
        }
      }
    }
    for (const entry of state.files) {
      const stored = await this.#file(scope, entry.fileId);
      if (stored.view.file.sha256 !== entry.sha256) throw new CaseError('CASE_FILE_CHANGED', 'Saved file checksum differs.');
    }
    for (const entry of state.loopRuns ?? []) {
      await validateSavedLoopRun(scope.root, entry, scope.caseId, state);
    }
    const validatedSessions = new Set<string>();
    for (const entry of state.executionSnapshots ?? []) {
      if (validatedSessions.has(entry.sessionId)) continue;
      await validateSavedExecutionSnapshot(scope.root, entry, scope.caseId, state);
      validatedSessions.add(entry.sessionId);
    }
    if ((state.outputs ?? []).length > 0) {
      const { validateSavedOutput } = await import('../outputs/store.ts');
      for (const entry of state.outputs ?? []) await validateSavedOutput(scope.root, entry, scope.caseId, state);
    }
  }

  async registerText(input: { caseId: string; sourceLabel: string; text: string }, options: { expectedRevision?: number } = {}): Promise<Material> {
    const { caseId, ...source } = caseRegisterTextSchema.parse(input);
    const scope = await this.#scope(caseId);
    const before = await this.#snapshot(scope);
    this.#checkExpectedRevision(before.record, options);
    const material = await scope.materials.registerText({ ...source, groupId: caseId });
    const { version } = await scope.texts.readVersion({ materialId: material.id, versionId: material.id });
    await this.#commit(scope, before, (state) => { state.materials.push({
      materialId: material.id, originalSha256: material.sha256, ocrAttemptIds: [], referenceIds: [],
      versions: [{ versionId: version.id, textSha256: version.textSha256 }],
    }); }, '保存文字材料');
    return material;
  }

  async registerImage(input: { caseId: string; sourceLabel: string; path: string }, options: { expectedRevision?: number } = {}): Promise<Material> {
    const { caseId, ...source } = caseRegisterImageSchema.parse(input);
    const scope = await this.#scope(caseId);
    const before = await this.#snapshot(scope);
    this.#checkExpectedRevision(before.record, options);
    const material = await scope.materials.registerImage({ ...source, groupId: caseId });
    await this.#commit(scope, before, (state) => { state.materials.push({
      materialId: material.id, originalSha256: material.sha256, ocrAttemptIds: [], versions: [], referenceIds: [],
    }); }, '保存图片材料');
    return material;
  }

  async readMaterial(input: { caseId: string; materialId: string }): Promise<MaterialView> {
    const { caseId, materialId } = caseMaterialRequestSchema.parse(input);
    const { view, entry } = await this.#activeMaterial(await this.#scope(caseId), materialId);
    return { ...view, ocrAttempts: view.ocrAttempts.filter((attempt) => entry.ocrAttemptIds.includes(attempt.id)) };
  }

  async recognize(input: { caseId: string; materialId: string }, ocr: OcrAdapter, options: { expectedRevision?: number } = {}): Promise<OcrAttempt> {
    const { caseId, materialId } = caseMaterialRequestSchema.parse(input);
    const scope = await this.#scope(caseId);
    const { snapshot: before } = await this.#activeMaterial(scope, materialId);
    this.#checkExpectedRevision(before.record, options);
    const result = await scope.materials.recognize(materialId, ocr);
    const version = result.status === 'success'
      ? (await scope.texts.readVersion({ materialId, versionId: result.id })).version : undefined;
    await this.#commit(scope, before, (state) => {
      const entry = this.#entry(state, materialId);
      entry.ocrAttemptIds.push(result.id);
      if (version) entry.versions.push({ versionId: version.id, textSha256: version.textSha256 });
    }, '保存 OCR 结果');
    return result;
  }

  async listVersions(input: { caseId: string; materialId: string }): Promise<TextVersion[]> {
    const { caseId, materialId } = caseMaterialRequestSchema.parse(input);
    const scope = await this.#scope(caseId);
    const { entry } = await this.#activeMaterial(scope, materialId);
    const versions = (await scope.texts.listVersions(materialId)).filter((version) => entry.versions.some((saved) => saved.versionId === version.id));
    if (versions.length !== entry.versions.length || versions.some((version) => (
      entry.versions.find((saved) => saved.versionId === version.id)!.textSha256 !== version.textSha256
    ))) throw new CaseError('CASE_VERSION_CHANGED', 'Current text versions differ from the saved case state.');
    return versions;
  }

  async readVersion(input: { caseId: string; materialId: string; versionId: string }): Promise<TextVersionView> {
    const { caseId, ...request } = caseVersionRequestSchema.parse(input);
    const scope = await this.#scope(caseId);
    const { entry } = await this.#activeMaterial(scope, request.materialId);
    const saved = this.#version(entry, request.versionId);
    const view = await scope.texts.readVersion(request);
    if (view.version.textSha256 !== saved.textSha256) throw new CaseError('CASE_VERSION_CHANGED', 'Text version differs from the saved case state.');
    return view;
  }

  async saveRevision(input: SaveRevisionInput & { caseId: string }): Promise<TextRevision> {
    const { caseId, ...request } = caseSaveRevisionSchema.parse(input);
    const scope = await this.#scope(caseId);
    const { snapshot: before, entry } = await this.#activeMaterial(scope, request.materialId);
    this.#version(entry, request.baseVersionId);
    const revision = await scope.texts.saveRevision(request);
    await this.#commit(scope, before, (state) => {
      this.#entry(state, request.materialId).versions.push({ versionId: revision.id, textSha256: revision.textSha256 });
    }, '保存人工文字修订', request.editor);
    return revision;
  }

  async createReference(input: CreateReferenceInput & { caseId: string }): Promise<SourceReference> {
    const { caseId, ...request } = caseCreateReferenceSchema.parse(input);
    const scope = await this.#scope(caseId);
    const { snapshot: before, entry } = await this.#activeMaterial(scope, request.materialId);
    this.#version(entry, request.versionId);
    const reference = await scope.references.create(request);
    await this.#commit(scope, before, (state) => {
      this.#entry(state, request.materialId).referenceIds.push(reference.id);
    }, '保存固定版本引用');
    return reference;
  }

  async resolveReference(input: ReferenceRequest & { caseId: string }): Promise<ResolvedReference> {
    const { caseId, ...request } = caseResolveReferenceSchema.parse(input);
    const scope = await this.#scope(caseId);
    await this.#material(scope, request.materialId);
    // Fixed references are historical provenance: rollback never invalidates their source IDs.
    return scope.references.resolve(request);
  }

  async importFile(input: ImportCaseFileInput, options: { expectedRevision?: number } = {}): Promise<StoredCaseFile> {
    const parsed = importCaseFileSchema.parse(input);
    const scope = await this.#scope(parsed.caseId);
    const before = await this.#snapshot(scope);
    this.#checkExpectedRevision(before.record, options);
    const info = await stat(parsed.path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      throw new CaseError('CASE_FILE_INVALID', 'Expected a local file no larger than 50 MiB.');
    }
    const bytes = await readFile(parsed.path);
    if (bytes.length > MAX_FILE_BYTES) throw new CaseError('CASE_FILE_INVALID', 'File exceeds 50 MiB.');
    const record = storedCaseFileSchema.parse({
      id: randomUUID(), caseId: parsed.caseId, fileName: basename(parsed.path), sourceLabel: parsed.sourceLabel,
      createdAt: new Date().toISOString(), byteLength: bytes.length, sha256: hash(bytes),
    });
    const directory = join(scope.root, 'files', record.id);
    await mkdir(directory, { recursive: true });
    await this.#writeNew(join(directory, 'original.bin'), bytes);
    // Commit metadata last; incomplete imports do not appear in case contents.
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await this.#writeNew(temporary, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'));
    try { await rename(temporary, join(directory, 'record.json')); }
    finally { await unlink(temporary).catch(() => {}); }
    await this.#commit(scope, before, (state) => { state.files.push({ fileId: record.id, sha256: record.sha256 }); }, '保存原始附件');
    return record;
  }

  async readFile(input: CaseFileRequest): Promise<CaseFileView> {
    const { caseId, fileId } = caseFileRequestSchema.parse(input);
    const scope = await this.#scope(caseId);
    const stored = await this.#file(scope, fileId);
    this.#activeFile((await this.#snapshot(scope)).workspace, stored.view.file);
    return stored.view;
  }

  async exportFile(input: ExportCaseFileInput): Promise<ExportedCaseFile> {
    const { caseId, fileId, destination } = exportCaseFileSchema.parse(input);
    const scope = await this.#scope(caseId);
    const { view, bytes } = await this.#file(scope, fileId);
    this.#activeFile((await this.#snapshot(scope)).workspace, view.file);
    return this.#export(bytes, destination, view.file.sha256);
  }

  async exportMaterial(input: { caseId: string; materialId: string; destination: string }): Promise<ExportedCaseFile> {
    const { caseId, materialId, destination } = exportCaseMaterialSchema.parse(input);
    const { view } = await this.#activeMaterial(await this.#scope(caseId), materialId);
    const bytes = await readFile(view.originalPath);
    if (hash(bytes) !== view.material.sha256 || bytes.length !== view.material.byteLength) {
      throw new CaseError('CASE_FILE_CHANGED', 'Original material changed before export.');
    }
    return this.#export(bytes, destination, view.material.sha256);
  }

  async #scope(caseId: string): Promise<Scope> {
    const id = caseIdSchema.parse(caseId);
    await this.#cases.read(id);
    const root = this.#cases.directory(id);
    const materials = new MaterialStore(root);
    const texts = new MaterialTextStore(root, materials);
    return { caseId: id, root, materials, texts, references: new SourceReferenceStore(root, texts) };
  }

  #checkExpectedRevision(record: CaseRecord, options: { expectedRevision?: number }): void {
    if (options.expectedRevision !== undefined && options.expectedRevision !== record.revision) {
      // This check runs before staging a resource or invoking OCR. Its subtype
      // lets a tool discard only its own preflight lock safely while preserving
      // the public conflict code; a later publication conflict is not this type.
      throw new CaseWriteStaleError();
    }
  }

  async #snapshot(scope: Scope): Promise<{ record: CaseRecord; workspace: CaseWorkspaceState }> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.#cases.readState(scope.caseId);
      if (current.workspace) return { record: current.record, workspace: current.workspace };
      // Bootstrap only legacy cases. Modern writers initialize before staging any new resource.
      const workspace: CaseWorkspaceState = { materials: [], files: [] };
      for (const id of await this.#committedIds(join(scope.root, 'materials'), 'material.json')) {
        const view = await this.#material(scope, id);
        const versions = await scope.texts.listVersions(id);
        const referenceIds: string[] = [];
        let references: string[] = [];
        try { references = await readdir(join(scope.root, 'materials', id, 'references')); }
        catch (error) { if (!missing(error)) throw error; }
        for (const name of references.filter((name) => name.endsWith('.json'))) {
          const referenceId = name.slice(0, -5);
          await scope.references.resolve({ materialId: id, referenceId });
          referenceIds.push(referenceId);
        }
        workspace.materials.push({ materialId: id, originalSha256: view.material.sha256,
          ocrAttemptIds: view.ocrAttempts.map((item) => item.id),
          versions: versions.map((item) => ({ versionId: item.id, textSha256: item.textSha256 })), referenceIds });
      }
      for (const id of await this.#committedIds(join(scope.root, 'files'), 'record.json')) {
        const file = (await this.#file(scope, id)).view.file;
        workspace.files.push({ fileId: id, sha256: file.sha256 });
      }
      try {
        const record = await this.#cases.commitWorkspace({ caseId: scope.caseId,
          expectedRevision: current.record.revision, workspace, actor: '系统：兼容旧案件', note: '初始化案件材料清单' });
        return { record, workspace };
      } catch (error) {
        if (!(error instanceof CaseError && error.code === 'CASE_REVISION_CONFLICT')) throw error;
      }
    }
    throw new CaseError('CASE_REVISION_CONFLICT', 'Case changed repeatedly while initializing its resource view.');
  }

  async #commit(
    scope: Scope, before: { record: CaseRecord; workspace: CaseWorkspaceState },
    change: (state: CaseWorkspaceState) => void, note: string, actor = '系统：材料操作',
  ): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = attempt === 0 ? before : await this.#snapshot(scope);
      if (current.record.revision !== before.record.revision) {
        const history = await this.#cases.history(scope.caseId);
        if (history.some((event) => event.revision > before.record.revision && event.kind === 'rolled_back')) {
          throw new CaseError('CASE_WORKSPACE_CHANGED', 'Case was rolled back during this save; staged data was preserved but was not added to the current view.');
        }
      }
      const workspace = structuredClone(current.workspace);
      change(workspace);
      try {
        await this.#cases.commitWorkspace({ caseId: scope.caseId, expectedRevision: current.record.revision, workspace, actor, note });
        return;
      } catch (error) {
        if (!(error instanceof CaseError && error.code === 'CASE_REVISION_CONFLICT')) throw error;
      }
    }
    throw new CaseError('CASE_REVISION_CONFLICT', 'Case changed repeatedly during this save; staged originals remain preserved.');
  }

  #entry(state: CaseWorkspaceState, materialId: string): WorkspaceMaterialState {
    const entry = state.materials.find((item) => item.materialId === materialId);
    if (!entry) throw new CaseError('CASE_MATERIAL_NOT_ACTIVE', 'Material is outside the current case view; restore a suitable checkpoint to use it.');
    return entry;
  }

  #version(entry: WorkspaceMaterialState, versionId: string): WorkspaceMaterialState['versions'][number] {
    const version = entry.versions.find((item) => item.versionId === versionId);
    if (!version) throw new CaseError('CASE_VERSION_NOT_ACTIVE', 'Text version is outside the current case view.');
    return version;
  }

  #checkOriginal(entry: WorkspaceMaterialState, view: MaterialView): void {
    if (entry.originalSha256 !== view.material.sha256) throw new CaseError('CASE_MATERIAL_CHANGED', 'Original differs from the saved case state.');
  }

  #activeFile(state: CaseWorkspaceState, file: StoredCaseFile): void {
    const entry = state.files.find((item) => item.fileId === file.id);
    if (!entry) throw new CaseError('CASE_FILE_NOT_ACTIVE', 'File is outside the current case view.');
    if (entry.sha256 !== file.sha256) throw new CaseError('CASE_FILE_CHANGED', 'File differs from the saved case state.');
  }

  async #activeMaterial(scope: Scope, materialId: string) {
    const snapshot = await this.#snapshot(scope);
    const view = await this.#material(scope, materialId);
    const entry = this.#entry(snapshot.workspace, view.material.id);
    this.#checkOriginal(entry, view);
    return { snapshot, view, entry };
  }

  async #material(scope: Scope, materialId: string): Promise<MaterialView> {
    const view = await scope.materials.read(materialIdSchema.parse(materialId));
    if (view.material.groupId !== scope.caseId) {
      throw new CaseError('CASE_MATERIAL_MISMATCH', 'Material does not belong to the selected case.');
    }
    return view;
  }

  async #file(scope: Scope, fileId: string): Promise<{ view: CaseFileView; bytes: Buffer }> {
    const id = caseIdSchema.parse(fileId);
    const directory = join(scope.root, 'files', id);
    let content: string;
    try { content = await readFile(join(directory, 'record.json'), 'utf8'); }
    catch (error) {
      if (missing(error)) throw new CaseError('CASE_FILE_NOT_FOUND', 'No such file in the selected case.');
      throw error;
    }
    let file: StoredCaseFile;
    try { file = storedCaseFileSchema.parse(JSON.parse(content)); }
    catch { throw new CaseError('CASE_FILE_RECORD_INVALID', 'Stored file record is malformed.'); }
    if (file.id !== id || file.caseId !== scope.caseId) {
      throw new CaseError('CASE_FILE_RECORD_INVALID', 'File identity differs from the selected case or directory.');
    }
    const originalPath = join(directory, 'original.bin');
    const bytes = await readFile(originalPath);
    if (hash(bytes) !== file.sha256 || bytes.length !== file.byteLength) {
      throw new CaseError('CASE_FILE_CHANGED', 'Saved file differs from its registered bytes.');
    }
    return { view: { file, originalPath }, bytes };
  }

  async #committedIds(directory: string, metadataFile: string): Promise<string[]> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (missing(error)) return []; throw error; }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !caseIdSchema.safeParse(entry.name).success) continue;
      try { await stat(join(directory, entry.name, metadataFile)); }
      catch (error) { if (missing(error)) continue; throw error; }
      ids.push(entry.name);
    }
    return ids;
  }

  async #export(bytes: Buffer, destination: string, sha256: string): Promise<ExportedCaseFile> {
    const target = await physicalLocation(destination);
    for (const root of ['cases', 'materials']) {
      const pathInRoot = relative(await physicalLocation(join(this.#dataDir, root)), target);
      if (!isAbsolute(pathInRoot) && pathInRoot !== '..' && !pathInRoot.startsWith(`..${sep}`)) {
        throw new CaseError('CASE_EXPORT_DESTINATION_INVALID', 'Export outside managed cases/materials directories.');
      }
    }
    await mkdir(dirname(target), { recursive: true });
    await this.#writeNew(target, bytes);
    return { destination: target, sha256 };
  }

  async #writeNew(path: string, bytes: Buffer): Promise<void> {
    const handle = await open(path, 'wx');
    let complete = false;
    try {
      await handle.writeFile(bytes);
      await handle.close();
      complete = true;
    } finally {
      if (!complete) {
        await handle.close().catch(() => {});
        // This call exclusively created the target. A failed export/import must
        // not leave a partial file that looks like a usable saved original.
        await unlink(path).catch(() => {});
      }
    }
  }
}
