import { z } from 'zod';
import { loopCheckpointSchema } from '../loops/contracts.ts';

const text = z.string().trim().min(1);
const object = z.record(z.string(), z.json());
export const agentSelectionSchema = z.strictObject({ materialId: z.uuid(), versionId: z.uuid() });
export const agentSourceKindsSchema = z.record(z.uuid(), z.enum(['party_statement', 'document_record']));
export const agentWorkflowSchema = z.strictObject({
  kind: z.enum(['intake', 'opponent_response', 'new_evidence', 'hearing_preparation']),
  profileId: text,
  selections: z.array(agentSelectionSchema).default([]),
  sourceKinds: agentSourceKindsSchema.optional(),
  previousOutputId: z.uuid().optional(),
  runId: z.uuid().optional(),
}).superRefine((value, ctx) => {
  if (value.kind !== 'intake' && !value.previousOutputId) {
    ctx.addIssue({ code: 'custom', path: ['previousOutputId'], message: '节点审查须指定上一版底稿。' });
  }
  if (value.runId && (value.kind !== 'hearing_preparation' || Object.keys(value.sourceKinds ?? {}).length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['runId'], message: '仅可在庭前准备中明确复用当前整理运行。' });
  }
});
export type AgentWorkflow = z.infer<typeof agentWorkflowSchema>;
export const agentActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tool'), toolId: text, toolVersion: z.number().int().positive(), arguments: object, reason: text }),
  z.strictObject({ kind: z.literal('reply'), message: text.max(20000), evidenceStepIds: z.array(z.uuid()).max(100) }),
  z.strictObject({ kind: z.literal('ask'), message: text.max(5000), reason: text, evidenceStepIds: z.array(z.uuid()).max(100) }),
]);
export type AgentAction = z.infer<typeof agentActionSchema>;
export const agentReplyVerdictSchema = z.strictObject({
  supported: z.boolean(), necessary: z.boolean(), reason: text.max(2000),
});
export const agentReplyAttemptSchema = z.strictObject({
  candidate: z.discriminatedUnion('kind', [agentActionSchema.options[1], agentActionSchema.options[2]]),
  verdict: agentReplyVerdictSchema.nullable(), createdAt: z.iso.datetime(),
});
export const agentLimitsSchema = z.strictObject({
  maxSteps: z.number().int().min(1).max(100).default(16),
  maxModelCalls: z.number().int().min(1).max(300).default(64),
});
export type AgentLimits = z.infer<typeof agentLimitsSchema>;
export const agentStepSchema = z.strictObject({
  id: z.uuid(), taskId: z.uuid(), operationId: z.uuid(), toolId: text, toolVersion: z.number().int().positive(),
  input: object, effect: z.enum(['read', 'write']), reason: text,
  status: z.enum(['prepared', 'running', 'completed', 'failed', 'uncertain']),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(), result: z.json().optional(), error: text.optional(),
  inputFingerprint: text,
  partial: z.strictObject({ information: loopCheckpointSchema.optional(), modelCalls: z.number().int().nonnegative().default(0),
    plan: object.optional(), profileSignature: text.optional() }).optional(),
});
export type AgentStep = z.infer<typeof agentStepSchema>;
export const agentTaskSchema = z.strictObject({
  id: z.uuid(), parentTaskId: z.uuid().nullable(), goal: text,
  status: z.enum(['running', 'waiting_input', 'interrupted', 'failed', 'completed', 'superseded']),
  createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(),
  inputFingerprint: text, environmentSignature: text,
  limits: agentLimitsSchema, usedSteps: z.number().int().nonnegative(), usedModelCalls: z.number().int().nonnegative(),
  workflow: agentWorkflowSchema.optional(),
  question: text.optional(), error: text.optional(),
  replyAttempts: z.array(agentReplyAttemptSchema).max(2).optional(),
});
export type AgentTask = z.infer<typeof agentTaskSchema>;
export const agentStateSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), caseId: z.uuid(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  activeTaskId: z.uuid().nullable(),
  messages: z.array(z.strictObject({ id: z.uuid(), taskId: z.uuid(), role: z.enum(['user', 'assistant']), text: text, createdAt: z.iso.datetime() })).max(2000),
  tasks: z.array(agentTaskSchema).max(1000), steps: z.array(agentStepSchema).max(10000),
  allowedPaths: z.array(text).max(100),
});
export type AgentState = z.infer<typeof agentStateSchema>;
export interface AgentEvent { kind: 'task' | 'tool' | 'checkpoint' | 'reply' | 'error'; message: string; taskId?: string; stepId?: string }
export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = 'AgentError'; this.code = code; }
}
