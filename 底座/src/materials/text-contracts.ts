import { z } from 'zod';
import { materialIdSchema, materialSchema, ocrEngineSchema, ocrLineSchema } from './contracts.ts';

export const textHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
function isWellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
const versionTextSchema = z.string().refine(isWellFormed, 'Text contains an isolated UTF-16 surrogate');
const offsetSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const versionBase = z.strictObject({
  id: z.uuid(), materialId: materialIdSchema, createdAt: z.iso.datetime(),
  text: versionTextSchema, textSha256: textHashSchema,
});

/** Original/recognized text is immutable; user edits create a separate version. */
export const textVersionSchema = z.discriminatedUnion('kind', [
  versionBase.extend({ kind: z.literal('original'), review: z.literal('original') }),
  versionBase.extend({
    kind: z.literal('ocr'), review: z.literal('unreviewed'),
    engine: ocrEngineSchema, lines: z.array(ocrLineSchema),
  }),
  versionBase.extend({
    kind: z.literal('revision'), review: z.literal('user_edited'),
    baseVersionId: z.uuid(), baseTextSha256: textHashSchema,
    editor: z.string().trim().min(1), note: z.string().optional(),
  }),
]);
export type TextVersion = z.infer<typeof textVersionSchema>;
export type TextRevision = Extract<TextVersion, { kind: 'revision' }>;
export const textVersionsSchema = z.array(textVersionSchema);
export const textVersionRequestSchema = z.strictObject({ materialId: materialIdSchema, versionId: z.uuid() });
export type TextVersionRequest = z.infer<typeof textVersionRequestSchema>;
export const textVersionViewSchema = z.strictObject({
  material: materialSchema, originalPath: z.string(), version: textVersionSchema,
});
export type TextVersionView = z.infer<typeof textVersionViewSchema>;

export const saveRevisionSchema = z.strictObject({
  materialId: materialIdSchema, baseVersionId: z.uuid(), baseTextSha256: textHashSchema,
  // Empty text is a valid user edit; nonempty excerpts are required for references.
  text: versionTextSchema, editor: z.string().trim().min(1), note: z.string().optional(),
});
export type SaveRevisionInput = z.infer<typeof saveRevisionSchema>;

export const createReferenceSchema = textVersionRequestSchema.extend({
  // JavaScript UTF-16 code units, half-open [start, end); cannot split a surrogate pair.
  start: offsetSchema, end: offsetSchema.positive(), quote: versionTextSchema.min(1),
}).refine((range) => range.end > range.start, 'End must be greater than start');
export type CreateReferenceInput = z.infer<typeof createReferenceSchema>;
export const sourceReferenceSchema = z.strictObject({
  id: z.uuid(), materialId: materialIdSchema, versionId: z.uuid(), createdAt: z.iso.datetime(),
  textSha256: textHashSchema,
  start: offsetSchema, end: offsetSchema.positive(), quote: versionTextSchema.min(1),
}).refine((reference) => reference.end > reference.start, 'End must be greater than start');
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export const referenceRequestSchema = z.strictObject({ materialId: materialIdSchema, referenceId: z.uuid() });
export type ReferenceRequest = z.infer<typeof referenceRequestSchema>;
export const resolvedReferenceSchema = textVersionViewSchema.extend({ reference: sourceReferenceSchema });
export type ResolvedReference = z.infer<typeof resolvedReferenceSchema>;
