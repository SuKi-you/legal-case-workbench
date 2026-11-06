import type { StandardSchemaV1 } from '@standard-schema/spec';

export const HOST_API_VERSION = 1 as const;

export type MaybePromise<T> = T | Promise<T>;

/** The version belongs to a capability's data contract, not its implementation. */
export interface CapabilityRef {
  readonly id: string;
  readonly version: number;
}

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: typeof HOST_API_VERSION;
  readonly requires?: readonly CapabilityRef[];
}

export type CapabilityOutcome<T = unknown> =
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'needs_input'; readonly reason: string }
  | { readonly status: 'not_applicable'; readonly reason: string };

export type InvocationErrorCode =
  | 'CONFIG_INVALID'
  | 'HOST_NOT_READY'
  | 'CAPABILITY_NOT_FOUND'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'UNDECLARED_DEPENDENCY'
  | 'CALL_CONTEXT_CLOSED'
  | 'INPUT_INVALID'
  | 'OUTPUT_INVALID'
  | 'VALIDATOR_FAILED'
  | 'INVALID_RESULT'
  | 'EXECUTION_FAILED';

export interface InvocationError {
  readonly code: InvocationErrorCode;
  readonly message: string;
  readonly stage?: 'input' | 'output';
  readonly issues?: readonly {
    readonly message: string;
    readonly path: readonly (string | number)[];
  }[];
}

export interface InvocationMeta {
  readonly callId: string;
  readonly parentCallId?: string;
  readonly capability: CapabilityRef;
  readonly provider?: { readonly id: string; readonly version: string };
}

export type InvocationResult = (
  | CapabilityOutcome
  | { readonly status: 'error'; readonly error: InvocationError }
) & { readonly meta: InvocationMeta };

export interface CapabilityContext {
  readonly callId: string;
  /** Only capabilities declared in this plugin's requires may be invoked here. */
  invoke(ref: CapabilityRef, input: unknown): Promise<InvocationResult>;
}

/** Explicit opt-in description for the agent's case-bound tool catalogue. */
export interface AgentCapabilityMetadata {
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly effect: 'read' | 'write';
}

export interface CapabilityDefinition extends CapabilityRef {
  readonly agent?: AgentCapabilityMetadata;
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
  /** The host validates and transforms the input before calling this function. */
  readonly execute: (
    input: unknown,
    context: CapabilityContext,
  ) => MaybePromise<CapabilityOutcome>;
}

export interface PluginSetupContext {
  /** Register during setup; also runs if setup fails after acquiring resources. */
  onDispose(dispose: () => MaybePromise<void>): void;
}

export interface PluginDefinition {
  readonly manifest: PluginManifest;
  readonly capabilities: readonly CapabilityDefinition[];
  readonly setup?: (context: PluginSetupContext) => MaybePromise<void>;
}

export interface HostOptions {
  /** Explicitly select active implementations here: one provider per capability. */
  readonly plugins: readonly PluginDefinition[];
}

export interface CapabilityDescription extends CapabilityRef {
  readonly provider: { readonly id: string; readonly version: string };
  readonly agent?: AgentCapabilityMetadata;
}

export interface StopResult {
  readonly status: 'stopped';
  readonly cleanupErrors: readonly { readonly pluginId: string; readonly message: string }[];
}

export interface PluginHost {
  readonly state: 'starting' | 'ready' | 'stopping' | 'stopped';
  listCapabilities(): readonly CapabilityDescription[];
  invoke(ref: CapabilityRef, input: unknown): Promise<InvocationResult>;
  /** Reject new root calls, drain accepted work, then dispose in reverse order. */
  stop(): Promise<StopResult>;
}

/** Infer a handler's types without binding the host to a schema library. */
export function defineCapability<
  Input extends StandardSchemaV1,
  Output extends StandardSchemaV1,
>(definition: {
  readonly id: string;
  readonly version: number;
  readonly input: Input;
  readonly output: Output;
  readonly agent?: AgentCapabilityMetadata;
  readonly execute: (
    input: StandardSchemaV1.InferOutput<Input>,
    context: CapabilityContext,
  ) => MaybePromise<CapabilityOutcome<StandardSchemaV1.InferInput<Output>>>;
}): CapabilityDefinition {
  const execute = definition.execute;
  return Object.freeze({
    id: definition.id,
    version: definition.version,
    input: definition.input,
    output: definition.output,
    ...(definition.agent ? { agent: definition.agent } : {}),
    execute: (input: unknown, context: CapabilityContext) =>
      execute(input as StandardSchemaV1.InferOutput<Input>, context),
  });
}
