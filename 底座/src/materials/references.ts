import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MaterialError } from './store.ts';
import { MaterialTextStore } from './versions.ts';
import {
  createReferenceSchema, referenceRequestSchema, resolvedReferenceSchema, sourceReferenceSchema,
  type CreateReferenceInput, type ReferenceRequest, type ResolvedReference,
  type SourceReference, type TextVersionView,
} from './text-contracts.ts';

const textHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function checkExcerpt(reference: Pick<SourceReference, 'start' | 'end' | 'quote'>, text: string): void {
  if (reference.start >= reference.end || reference.end > text.length
    || splitsSurrogatePair(text, reference.start) || splitsSurrogatePair(text, reference.end)) {
    throw new MaterialError('REFERENCE_RANGE_INVALID', 'Excerpt must use valid UTF-16 boundaries within the selected text version.');
  }
  if (text.slice(reference.start, reference.end) !== reference.quote) {
    throw new MaterialError('REFERENCE_QUOTE_MISMATCH', 'Excerpt does not match the selected text and position.');
  }
}

/** Exact text provenance only: a matching excerpt does not establish legal or factual truth. */
export class SourceReferenceStore {
  readonly #root: string;
  readonly #texts: MaterialTextStore;

  constructor(dataDir: string, texts?: MaterialTextStore) {
    this.#root = join(resolve(dataDir), 'materials');
    this.#texts = texts ?? new MaterialTextStore(dataDir);
  }

  async create(input: CreateReferenceInput): Promise<SourceReference> {
    const parsed = createReferenceSchema.parse(input);
    const view = await this.#texts.readVersion({ materialId: parsed.materialId, versionId: parsed.versionId });
    this.#checkVersion(view, parsed.materialId, parsed.versionId);
    checkExcerpt(parsed, view.version.text);
    const reference = sourceReferenceSchema.parse({
      id: randomUUID(), materialId: parsed.materialId, versionId: parsed.versionId,
      createdAt: new Date().toISOString(), textSha256: view.version.textSha256,
      start: parsed.start, end: parsed.end, quote: parsed.quote,
    });
    const directory = join(this.#root, reference.materialId, 'references');
    await mkdir(directory, { recursive: true });
    const finalPath = join(directory, `${reference.id}.json`);
    const temporary = join(directory, `${reference.id}.${randomUUID()}.tmp`);
    let ownTemporary = false;
    try {
      const handle = await open(temporary, 'wx');
      ownTemporary = true;
      try { await handle.writeFile(`${JSON.stringify(reference, null, 2)}\n`); }
      finally { await handle.close(); }
      // Same-directory hard-link publication is atomic and never replaces an existing record.
      await link(temporary, finalPath);
    } finally {
      // Only remove the temporary path created by this call, never the published record.
      if (ownTemporary) await unlink(temporary).catch(() => {});
    }
    return reference;
  }

  async resolve(input: ReferenceRequest): Promise<ResolvedReference> {
    const parsed = referenceRequestSchema.parse(input);
    const path = join(this.#root, parsed.materialId, 'references', `${parsed.referenceId}.json`);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new MaterialError('REFERENCE_NOT_FOUND', `No saved reference ${parsed.referenceId} for this material.`);
      }
      throw error;
    }
    let reference: SourceReference;
    try {
      reference = sourceReferenceSchema.parse(JSON.parse(content));
    } catch {
      throw new MaterialError('REFERENCE_INVALID', 'Saved reference is malformed.');
    }
    if (reference.materialId !== parsed.materialId || reference.id !== parsed.referenceId) {
      throw new MaterialError('REFERENCE_INVALID', 'Saved reference identity differs from its material or filename.');
    }
    const view = await this.#texts.readVersion({ materialId: parsed.materialId, versionId: reference.versionId });
    this.#checkVersion(view, reference.materialId, reference.versionId);
    if (reference.textSha256 !== view.version.textSha256) {
      throw new MaterialError('REFERENCE_VERSION_CHANGED', 'Saved reference no longer matches the selected text version checksum.');
    }
    checkExcerpt(reference, view.version.text);
    // Revision text has no inherited OCR boxes. The original path is supplied for manual comparison.
    return resolvedReferenceSchema.parse({ ...view, reference });
  }

  #checkVersion(view: TextVersionView, materialId: string, versionId: string): void {
    if (view.material.id !== materialId || view.version.materialId !== materialId || view.version.id !== versionId
      || textHash(view.version.text) !== view.version.textSha256) {
      throw new MaterialError('TEXT_VERSION_INVALID', 'Selected text version has inconsistent identity or checksum.');
    }
  }
}
