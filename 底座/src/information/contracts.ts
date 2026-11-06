import { z } from 'zod';
import { createReferenceSchema, textHashSchema } from '../materials/text-contracts.ts';

const text = z.string().trim().min(1);
const nullableText = text.nullable();
export const informationEntitySchema = z.strictObject({
  name: text, kind: z.enum(['person', 'organization', 'unknown']),
  identity: z.strictObject({ scheme: text, value: text }).nullable(),
});
export type InformationEntity = z.infer<typeof informationEntitySchema>;
export const informationTimeSchema = z.strictObject({
  raw: nullableText, start: nullableText, end: nullableText,
  precision: z.enum(['date', 'month', 'range', 'relative', 'unknown']),
});
export const informationValueSchema = z.strictObject({
  kind: z.enum(['money', 'number', 'text', 'boolean', 'date', 'unknown']),
  raw: nullableText, normalized: nullableText, unit: nullableText,
});
export const informationRecordSchema = z.strictObject({
  topic: text, subject: informationEntitySchema.nullable(), object: informationEntitySchema.nullable(),
  attributedTo: informationEntitySchema.nullable(),
  event: z.strictObject({ type: text, key: nullableText, description: text }),
  time: informationTimeSchema, value: informationValueSchema,
  polarity: z.enum(['affirmed', 'denied', 'uncertain']),
  period: nullableText, basis: nullableText,
  origin: z.enum(['party_statement', 'document_record', 'inference']),
  qualifiers: z.record(z.string(), z.string()), uncertainty: z.array(text),
});
export type InformationRecord = z.infer<typeof informationRecordSchema>;
export const informationCitationSchema = createReferenceSchema.safeExtend({ textSha256: textHashSchema });
export const informationFindingSchema = z.strictObject({
  id: z.uuid(), needId: text, statement: text, citations: z.array(informationCitationSchema).min(1),
  record: informationRecordSchema.optional(),
});
export type InformationFinding = z.infer<typeof informationFindingSchema>;
export const informationSourceSchema = z.strictObject({ materialId: z.uuid(), versionId: z.uuid(), textSha256: textHashSchema });
export type InformationSource = z.infer<typeof informationSourceSchema>;
export const needSpecSchema = z.strictObject({
  topic: text, subject: nullableText, object: nullableText, period: nullableText, basis: nullableText,
  requiredFields: z.array(z.enum(['subject', 'object', 'attributedTo', 'event.key', 'time', 'value', 'period', 'basis'])),
  minimumSupport: z.enum(['statement', 'document']), applicable: z.boolean(),
});
export type NeedSpec = z.infer<typeof needSpecSchema>;
export const structuredNeedSchema = z.strictObject({ id: text, question: text, reason: text, spec: needSpecSchema.optional() });
export type StructuredNeed = z.infer<typeof structuredNeedSchema>;
export const informationRelationSchema = z.strictObject({
  id: text,
  kind: z.enum(['same_entity', 'possible_same_entity', 'same_event', 'possible_same_event', 'equivalent_claim', 'same_source_content']),
  findingIds: z.array(z.uuid()).min(2), status: z.enum(['confirmed', 'suggested']), reason: text,
});
export type InformationRelation = z.infer<typeof informationRelationSchema>;
export const informationConflictSchema = z.strictObject({
  id: text, findingIds: z.array(z.uuid()).length(2), field: text,
  classification: z.enum(['inconsistent', 'possible_conflict', 'different_scope', 'insufficient_context']), reason: text,
});
export type InformationConflict = z.infer<typeof informationConflictSchema>;
export const informationEntityGroupSchema = z.strictObject({
  id: text, names: z.array(text), kind: z.enum(['person', 'organization', 'unknown']),
  findingIds: z.array(z.uuid()),
});
export const needCoverageSchema = z.strictObject({
  needId: text, findingIds: z.array(z.uuid()), conflictIds: z.array(text),
  coverage: z.enum(['found', 'partial', 'not_found_in_examined', 'unread']),
  consistency: z.enum(['consistent', 'ambiguous', 'conflicting']),
  support: z.enum(['statement_only', 'document_supported', 'inference_only', 'none']),
  satisfaction: z.enum(['satisfied', 'needs_review', 'needs_information', 'not_applicable']),
  missingFields: z.array(text), examined: z.array(informationSourceSchema), unread: z.array(informationSourceSchema),
  reason: text,
  nextActions: z.array(z.strictObject({ kind: z.enum(['read', 'clarify', 'review']), needId: text, reason: text, instruction: text })),
});
export type NeedCoverage = z.infer<typeof needCoverageSchema>;
export const informationAnalysisSchema = z.strictObject({
  version: z.literal(1), entities: z.array(informationEntityGroupSchema),
  relations: z.array(informationRelationSchema), conflicts: z.array(informationConflictSchema),
  needs: z.array(needCoverageSchema),
});
export type InformationAnalysis = z.infer<typeof informationAnalysisSchema>;
export const entityBindingSchema = z.strictObject({
  names: z.array(text).min(2), canonical: text, reason: text,
});
export type EntityBinding = z.infer<typeof entityBindingSchema>;
export interface InformationCompareOptions { bindings?: readonly EntityBinding[] }
export interface InformationAttempt {
  request: { needId: string; instruction: string; reason: string };
  examined: InformationSource[];
  findingIds: string[];
  note: string;
  readIssues?: readonly { source: InformationSource }[] | undefined;
}
