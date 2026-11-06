import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { CapabilityRef } from '../contracts.ts';
import type { LoopRun } from '../loops/contracts.ts';
import type { JsonModel } from '../information/model.ts';

/** Services are bound to this case and this execution, never a process-global current case. */
export interface PluginServices {
  readonly runs: { readonly read: (runId: string) => Promise<LoopRun> };
  /** Every request reserves the same persisted budget as planning and extraction. */
  readonly model: JsonModel;
}

export interface AgentToolDescription extends CapabilityRef {
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly effect: 'read' | 'write';
  readonly provider?: { readonly id: string; readonly version: string };
}
export interface AgentToolContext {
  readonly caseId: string;
  readonly operationId: string;
  readonly userMessage: string;
  readonly signal?: AbortSignal;
  /** File paths explicitly attached by the person using the terminal. */
  readonly allowedPaths?: readonly string[];
  /** Revision captured after the executor saved its running-step checkpoint. */
  readonly expectedCaseRevision?: number;
  readonly services?: PluginServices;
}
export type AgentToolReconciliation =
  | { readonly status: 'completed'; readonly result: unknown }
  | { readonly status: 'not_started' }
  | { readonly status: 'unknown'; readonly reason?: string };

export interface AgentTool extends AgentToolDescription {
  readonly input: StandardSchemaV1;
  readonly execute: (input: unknown, context: AgentToolContext) => Promise<unknown>;
  readonly reconcile?: (input: unknown, context: AgentToolContext) => Promise<AgentToolReconciliation>;
}

export class AgentToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = 'AgentToolError'; this.code = code; }
}

/** Retain inferred input types while the catalogue consumes Standard Schema. */
export function defineAgentTool<Input extends StandardSchemaV1>(definition: Omit<AgentTool, 'input' | 'execute' | 'reconcile'> & {
  input: Input;
  execute(input: StandardSchemaV1.InferOutput<Input>, context: AgentToolContext): Promise<unknown>;
  reconcile?(input: StandardSchemaV1.InferOutput<Input>, context: AgentToolContext): Promise<AgentToolReconciliation>;
}): AgentTool {
  return {
    ...definition,
    execute: (input, context) => definition.execute(input as StandardSchemaV1.InferOutput<Input>, context),
    ...(definition.reconcile ? { reconcile: (input: unknown, context: AgentToolContext) => definition.reconcile!(input as StandardSchemaV1.InferOutput<Input>, context) } : {}),
  };
}
