import { z } from 'zod';
import { caseIdSchema } from '../cases/contracts.ts';

/** Payload semantics belong to the task controller; storage accepts JSON only. */
export const executionPayloadSchema = z.record(z.string(), z.json());
export type ExecutionPayload = z.infer<typeof executionPayloadSchema>;
export const executionSnapshotSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), sessionId: z.uuid(), caseId: caseIdSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), previousId: z.uuid().nullable(),
  createdAt: z.iso.datetime(), payload: executionPayloadSchema,
});
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;
export const saveExecutionSnapshotSchema = z.strictObject({
  caseId: caseIdSchema, sessionId: z.uuid(), payload: executionPayloadSchema,
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), previousSnapshotId: z.uuid().nullable(),
});
export type SaveExecutionSnapshotInput = z.input<typeof saveExecutionSnapshotSchema>;
export const executionSessionRequestSchema = z.strictObject({ caseId: caseIdSchema, sessionId: z.uuid() });
export interface SavedExecutionSnapshot { snapshot: ExecutionSnapshot; caseRevision: number }
