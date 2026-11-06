import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { materialIdSchema, type MaterialView } from './contracts.ts';
import { MaterialError, MaterialStore } from './store.ts';
import {
  saveRevisionSchema, textVersionRequestSchema, textVersionSchema,
  type SaveRevisionInput, type TextRevision, type TextVersion,
  type TextVersionRequest, type TextVersionView,
} from './text-contracts.ts';

const textHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const isMissing = (error: unknown): boolean => (
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
);

/**
 * Explicit text versions over the existing originals/OCR records, with no latest pointer.
 * Edits are independent immutable records, so concurrent edits preserve both branches.
 */
export class MaterialTextStore {
  readonly #root: string;
  readonly #materials: MaterialStore;

  constructor(dataDir: string, materials?: MaterialStore) {
    this.#root = join(resolve(dataDir), 'materials');
    this.#materials = materials ?? new MaterialStore(dataDir);
  }

  async listVersions(materialId: string): Promise<TextVersion[]> {
    return (await this.#snapshot(materialId)).versions;
  }

  async readVersion(input: TextVersionRequest): Promise<TextVersionView> {
    const { materialId, versionId } = textVersionRequestSchema.parse(input);
    const { view, versions } = await this.#snapshot(materialId);
    const version = versions.find((candidate) => candidate.id === versionId);
    if (!version) throw new MaterialError('VERSION_NOT_FOUND', `No readable text version ${versionId} in material ${materialId}.`);
    return { material: view.material, originalPath: view.originalPath, version };
  }

  async saveRevision(input: SaveRevisionInput): Promise<TextRevision> {
    const parsed = saveRevisionSchema.parse(input);
    const { version: base } = await this.readVersion({
      materialId: parsed.materialId, versionId: parsed.baseVersionId,
    });
    if (parsed.baseTextSha256 !== base.textSha256) {
      throw new MaterialError('BASE_VERSION_CHANGED', 'The selected base text does not match the submitted checksum.');
    }
    const revision = textVersionSchema.parse({
      id: randomUUID(), materialId: parsed.materialId, createdAt: new Date().toISOString(),
      kind: 'revision', review: 'user_edited', text: parsed.text, textSha256: textHash(parsed.text),
      baseVersionId: base.id, baseTextSha256: base.textSha256, editor: parsed.editor,
      ...(parsed.note === undefined ? {} : { note: parsed.note }),
    });
    // Narrowing also guards this boundary if the contract union changes later.
    if (revision.kind !== 'revision') throw new MaterialError('RECORD_INVALID', 'Expected a manual text revision.');
    const directory = this.#revisionDirectory(parsed.materialId);
    await mkdir(directory, { recursive: true });
    const target = join(directory, `${revision.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(revision, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, target);
    return revision;
  }

  #revisionDirectory(materialId: string): string {
    return join(this.#root, materialIdSchema.parse(materialId), 'text-revisions');
  }

  async #snapshot(materialId: string): Promise<{ view: MaterialView; versions: TextVersion[] }> {
    const id = materialIdSchema.parse(materialId);
    const versions: TextVersion[] = [];
    // Fix the revision set before reading its immutable sources. If another
    // process adds OCR and then a revision while this read runs, we must not
    // observe that revision against an older OCR directory snapshot.
    const directory = this.#revisionDirectory(id);
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) {
      if (!isMissing(error)) throw error;
      files = []; // Originals and OCR written before this feature need no migration.
    }
    for (const file of files.filter((name) => name.endsWith('.json'))) {
      let content: unknown;
      try { content = JSON.parse(await readFile(join(directory, file), 'utf8')); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new MaterialError('RECORD_INVALID', `Cannot parse text revision ${file}.`);
      }
      const revision = this.#parseVersion(content);
      if (revision.kind !== 'revision' || revision.materialId !== id || file !== `${revision.id}.json`) {
        throw new MaterialError('RECORD_INVALID', 'Text revision identity differs from its material or filename.');
      }
      versions.push(revision);
    }
    // Existing material reads verify original integrity and OCR identity.
    const view = await this.#materials.read(id);
    if (view.material.original.kind === 'text') {
      if (view.text === undefined || view.ocrAttempts.length > 0) {
        throw new MaterialError('RECORD_INVALID', 'Plain-text original has invalid text/OCR records.');
      }
      versions.push(this.#parseVersion({
        id, materialId: id, createdAt: view.material.createdAt, kind: 'original', review: 'original',
        text: view.text, textSha256: textHash(view.text),
      }));
    } else {
      for (const attempt of view.ocrAttempts) {
        if (attempt.status !== 'success') continue;
        versions.push(this.#parseVersion({
          id: attempt.id, materialId: id, createdAt: attempt.createdAt, kind: 'ocr', review: 'unreviewed',
          text: attempt.output.text, textSha256: textHash(attempt.output.text),
          engine: attempt.engine, lines: attempt.output.lines,
        }));
      }
    }

    this.#validateGraph(versions);
    // This presentation order never selects or changes the version a caller uses.
    versions.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return { view, versions };
  }

  #parseVersion(value: unknown): TextVersion {
    const parsed = textVersionSchema.safeParse(value);
    if (!parsed.success) throw new MaterialError('RECORD_INVALID', 'Stored text version does not satisfy its contract.');
    if (parsed.data.textSha256 !== textHash(parsed.data.text)) {
      throw new MaterialError('TEXT_VERSION_CHANGED', 'Stored text differs from its recorded checksum.');
    }
    return parsed.data;
  }

  #validateGraph(versions: readonly TextVersion[]): void {
    const byId = new Map<string, TextVersion>();
    for (const version of versions) {
      if (byId.has(version.id)) throw new MaterialError('RECORD_INVALID', 'Text version identities conflict.');
      byId.set(version.id, version);
    }
    const children = new Map<string, string[]>();
    const queue: string[] = [];
    for (const version of versions) {
      if (version.kind !== 'revision') { queue.push(version.id); continue; }
      const parent = byId.get(version.baseVersionId);
      if (!parent || parent.textSha256 !== version.baseTextSha256) {
        throw new MaterialError('RECORD_INVALID', 'Text revision base is missing or differs from its recorded checksum.');
      }
      const siblings = children.get(parent.id) ?? [];
      siblings.push(version.id);
      children.set(parent.id, siblings);
    }
    // Each revision has exactly one parent. Traversal from roots detects cycles
    // without recursion, even for a long sequence of user edits.
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index]!;
      for (const child of children.get(id) ?? []) queue.push(child);
    }
    if (queue.length !== versions.length) {
      throw new MaterialError('RECORD_INVALID', 'Text revision ancestry contains a cycle.');
    }
  }
}
