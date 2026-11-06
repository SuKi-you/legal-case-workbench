import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  materialIdSchema, materialSchema, ocrAttemptSchema, ocrEngineSchema, ocrOutputSchema,
  registerImageSchema, registerTextSchema,
  type Material, type MaterialView, type OcrAdapter, type OcrAttempt,
} from './contracts.ts';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export class MaterialError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MaterialError';
    this.code = code;
  }
}

/** Local, append-only materials. This is not a case database or task checkpoint store. */
export class MaterialStore {
  readonly #root: string;

  constructor(dataDir: string) {
    this.#root = join(resolve(dataDir), 'materials');
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  async registerText(input: { groupId: string; sourceLabel: string; text: string }): Promise<Material> {
    const parsed = registerTextSchema.parse(input);
    return this.#register(parsed, Buffer.from(parsed.text, 'utf8'), {
      kind: 'text', file: 'original.txt', mediaType: 'text/plain',
    });
  }

  async registerImage(input: { groupId: string; sourceLabel: string; path: string }): Promise<Material> {
    const parsed = registerImageSchema.parse(input);
    const info = await stat(parsed.path);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) {
      throw new MaterialError('IMAGE_INVALID', 'Expected a PNG/JPEG file no larger than 20 MiB.');
    }
    // Copy the bytes now: later changes to the caller's file must not alter our original.
    const bytes = await readFile(parsed.path);
    if (bytes.length > MAX_IMAGE_BYTES) throw new MaterialError('IMAGE_INVALID', 'Image exceeds 20 MiB.');
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) throw new MaterialError('IMAGE_UNSUPPORTED', 'Only PNG and JPEG are supported in this step.');
    return this.#register(parsed, bytes, png
      ? { kind: 'image', file: 'original.png', mediaType: 'image/png' }
      : { kind: 'image', file: 'original.jpg', mediaType: 'image/jpeg' });
  }

  async read(materialId: string): Promise<MaterialView> {
    const { material, bytes, directory } = await this.#load(materialId);
    const files = await readdir(join(directory, 'ocr'));
    const attempts = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
      const attempt = ocrAttemptSchema.parse(JSON.parse(await readFile(join(directory, 'ocr', file), 'utf8')));
      if (attempt.materialId !== material.id || file !== `${attempt.id}.json`) {
        throw new MaterialError('RECORD_INVALID', 'OCR record is linked to a different original.');
      }
      return attempt;
    }));
    attempts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return {
      material, originalPath: join(directory, material.original.file), ocrAttempts: attempts,
      ...(material.original.kind === 'text' ? { text: bytes.toString('utf8') } : {}),
    };
  }

  async recognize(materialId: string, adapter: OcrAdapter): Promise<OcrAttempt> {
    const { material, bytes, directory } = await this.#load(materialId);
    if (material.original.kind !== 'image') throw new MaterialError('NOT_AN_IMAGE', 'This original is plain text.');
    const base = {
      id: randomUUID(), materialId: material.id, createdAt: new Date().toISOString(),
      engine: ocrEngineSchema.parse(adapter.engine), review: 'unreviewed' as const,
    };
    let attempt: OcrAttempt;
    try {
      const output = ocrOutputSchema.parse(await adapter.recognize(bytes));
      attempt = output.text.trim().length === 0
        ? { ...base, status: 'failed', error: { code: 'NO_TEXT', message: 'No readable text detected; check the original image.' } }
        : { ...base, status: 'success', output };
    } catch (error) {
      // Record the failed attempt while keeping the image available for another attempt.
      attempt = { ...base, status: 'failed', error: {
        code: 'OCR_FAILED', message: error instanceof Error && error.message ? error.message : 'OCR adapter failed.',
      } };
    }
    await this.#writeJson(join(directory, 'ocr', `${attempt.id}.json`), ocrAttemptSchema.parse(attempt));
    return attempt;
  }

  async #register(
    source: { groupId: string; sourceLabel: string }, bytes: Buffer, original: Material['original'],
  ): Promise<Material> {
    await this.initialize();
    const material = materialSchema.parse({
      id: randomUUID(), groupId: source.groupId, sourceLabel: source.sourceLabel,
      createdAt: new Date().toISOString(), original, sha256: sha256(bytes), byteLength: bytes.length,
    });
    const directory = this.#directory(material.id);
    await mkdir(directory);
    await mkdir(join(directory, 'ocr'));
    await writeFile(join(directory, original.file), bytes, { flag: 'wx' });
    // Commit metadata last. Incomplete registrations are never returned as usable materials.
    await this.#writeJson(join(directory, 'material.json'), material);
    return material;
  }

  #directory(id: string): string {
    return join(this.#root, materialIdSchema.parse(id));
  }

  async #load(id: string): Promise<{ material: Material; bytes: Buffer; directory: string }> {
    const directory = this.#directory(id);
    let content: string;
    try {
      content = await readFile(join(directory, 'material.json'), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new MaterialError('MATERIAL_NOT_FOUND', `No registered material ${id}.`);
      }
      throw error;
    }
    const material = materialSchema.parse(JSON.parse(content));
    if (material.id !== id) throw new MaterialError('RECORD_INVALID', 'Material identity differs from its directory.');
    const bytes = await readFile(join(directory, material.original.file));
    if (bytes.length !== material.byteLength || sha256(bytes) !== material.sha256) {
      throw new MaterialError('ORIGINAL_CHANGED', 'Saved original differs from its registered checksum.');
    }
    return { material, bytes, directory };
  }

  async #writeJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  }
}
