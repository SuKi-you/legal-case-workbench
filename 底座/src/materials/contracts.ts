import { z } from 'zod';

export const materialIdSchema = z.uuid();
export const sourceInputSchema = z.strictObject({
  groupId: z.string().trim().min(1),
  sourceLabel: z.string().trim().min(1),
});
export const registerTextSchema = sourceInputSchema.extend({
  text: z.string().refine((text) => text.trim().length > 0, 'Text must not be blank'),
});
export const registerImageSchema = sourceInputSchema.extend({ path: z.string().min(1) });
export const materialRequestSchema = z.strictObject({ materialId: materialIdSchema });

const originalSchema = z.union([
  z.strictObject({ kind: z.literal('text'), file: z.literal('original.txt'), mediaType: z.literal('text/plain') }),
  z.strictObject({ kind: z.literal('image'), file: z.literal('original.png'), mediaType: z.literal('image/png') }),
  z.strictObject({ kind: z.literal('image'), file: z.literal('original.jpg'), mediaType: z.literal('image/jpeg') }),
]);

export const materialSchema = sourceInputSchema.extend({
  id: materialIdSchema,
  createdAt: z.iso.datetime(),
  original: originalSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
});
export type Material = z.infer<typeof materialSchema>;

export const ocrEngineSchema = z.strictObject({
  id: z.string().min(1), version: z.string().min(1), languages: z.array(z.string().min(1)).min(1),
});
export const ocrLineSchema = z.strictObject({
  text: z.string(),
  confidence: z.number().min(0).max(100),
  // Pixel coordinates in the unchanged original image; no automatic rotation in v1.
  box: z.strictObject({
    x0: z.number().nonnegative(), y0: z.number().nonnegative(),
    x1: z.number().nonnegative(), y1: z.number().nonnegative(),
  }).refine((box) => box.x1 >= box.x0 && box.y1 >= box.y0, 'Invalid bounding box'),
});
export const ocrOutputSchema = z.strictObject({
  text: z.string(), confidence: z.number().min(0).max(100), lines: z.array(ocrLineSchema),
});
export type OcrOutput = z.infer<typeof ocrOutputSchema>;
export type OcrEngine = z.infer<typeof ocrEngineSchema>;

const attemptBase = z.strictObject({
  id: z.uuid(), materialId: materialIdSchema, createdAt: z.iso.datetime(),
  engine: ocrEngineSchema,
  review: z.literal('unreviewed'),
});
export const ocrAttemptSchema = z.discriminatedUnion('status', [
  attemptBase.extend({ status: z.literal('success'), output: ocrOutputSchema }),
  attemptBase.extend({ status: z.literal('failed'), error: z.strictObject({
    code: z.enum(['OCR_FAILED', 'NO_TEXT']), message: z.string().min(1),
  }) }),
]);
export type OcrAttempt = z.infer<typeof ocrAttemptSchema>;
export const materialViewSchema = z.strictObject({
  material: materialSchema,
  originalPath: z.string(),
  text: z.string().optional(),
  ocrAttempts: z.array(ocrAttemptSchema),
});
export type MaterialView = z.infer<typeof materialViewSchema>;

/** A replaceable image reader. Its output is a transcription, never a legal finding. */
export interface OcrAdapter {
  readonly engine: OcrEngine;
  recognize(image: Buffer): Promise<OcrOutput>;
  close(): Promise<void>;
}

export const MATERIAL_CAPABILITIES = Object.freeze({
  registerText: { id: 'materials.register-text', version: 1 },
  registerImage: { id: 'materials.register-image', version: 1 },
  read: { id: 'materials.read', version: 1 },
  recognize: { id: 'materials.recognize', version: 1 },
  listVersions: { id: 'materials.list-text-versions', version: 1 },
  readVersion: { id: 'materials.read-text-version', version: 1 },
  saveRevision: { id: 'materials.save-text-revision', version: 1 },
  createReference: { id: 'materials.create-reference', version: 1 },
  resolveReference: { id: 'materials.resolve-reference', version: 1 },
});
