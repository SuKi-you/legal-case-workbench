import { z } from 'zod';
import type { CapabilityRef, PluginHost } from '../contracts.ts';
import { caseIdSchema } from '../cases/contracts.ts';
import { validate } from '../validation.ts';
import { AgentToolError, type AgentTool, type AgentToolContext, type AgentToolDescription, type AgentToolReconciliation } from './contracts.ts';

function assertActive(context: AgentToolContext): void {
  caseIdSchema.parse(context.caseId); z.uuid().parse(context.operationId);
  if (context.signal?.aborted) throw new AgentToolError('AGENT_CANCELLED', 'Tool execution was cancelled.');
}
function checkScope(value: unknown, caseId: string, depth = 0): void {
  if (depth > 50) throw new AgentToolError('TOOL_INPUT_INVALID', 'Tool input exceeds the nesting limit.');
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'caseId' && (typeof item !== 'string' || item.toLowerCase() !== caseId.toLowerCase())) {
      throw new AgentToolError('TOOL_CASE_MISMATCH', 'Tools cannot select a different case from their bound session.');
    }
    checkScope(item, caseId, depth + 1);
  }
}
function description(tool: AgentTool): AgentToolDescription {
  return { id: tool.id, version: tool.version, description: tool.description, inputSchema: structuredClone(tool.inputSchema), effect: tool.effect,
    ...(tool.provider ? { provider: { ...tool.provider } } : {}) };
}

export class AgentToolCatalog {
  readonly #tools = new Map<string, AgentTool>();
  constructor(tools: readonly AgentTool[]) {
    for (const tool of tools) {
      if (!tool.id.trim() || !Number.isSafeInteger(tool.version) || tool.version < 1 || !tool.description.trim()
        || !['read', 'write'].includes(tool.effect) || this.#tools.has(tool.id)) {
        throw new AgentToolError('TOOL_CONFIG_INVALID', 'Tool IDs must be unique and every tool needs a version, description and effect.');
      }
      this.#tools.set(tool.id, { ...tool, inputSchema: structuredClone(tool.inputSchema), ...(tool.provider ? { provider: { ...tool.provider } } : {}) });
    }
  }
  list(): AgentToolDescription[] { return [...this.#tools.values()].map(description); }
  get(ref: CapabilityRef): AgentTool {
    const tool = this.#tools.get(ref.id);
    if (!tool) throw new AgentToolError('TOOL_NOT_FOUND', 'The requested tool is not registered.');
    if (tool.version !== ref.version) throw new AgentToolError('TOOL_VERSION_MISMATCH', 'The requested tool version is not installed.');
    return { ...tool, inputSchema: structuredClone(tool.inputSchema), ...(tool.provider ? { provider: { ...tool.provider } } : {}) };
  }
  async #input(tool: AgentTool, input: unknown, context: AgentToolContext): Promise<unknown> {
    assertActive(context); checkScope(input, context.caseId);
    const parsed = await validate(tool.input, input, 'input');
    if (!parsed.ok) throw new AgentToolError('TOOL_INPUT_INVALID', parsed.error.message);
    checkScope(parsed.value, context.caseId); assertActive(context); return parsed.value;
  }
  async execute(ref: CapabilityRef, input: unknown, context: AgentToolContext): Promise<unknown> {
    const tool = this.get(ref), parsed = await this.#input(tool, input, context);
    const result = await tool.execute(parsed, context);
    // A completed write must remain observable even if cancellation arrived
    // while its atomic save was finishing. Recovery reconciles that operation.
    if (tool.effect === 'read') assertActive(context);
    return result;
  }
  async reconcile(ref: CapabilityRef, input: unknown, context: AgentToolContext): Promise<AgentToolReconciliation> {
    const tool = this.get(ref), parsed = await this.#input(tool, input, context);
    if (tool.effect === 'read') return { status: 'not_started' };
    return tool.reconcile ? tool.reconcile(parsed, context) : { status: 'unknown', reason: 'This plugin does not declare how to reconcile a write after interruption.' };
  }
}

/** Opted-in plugins can join the same catalogue without domain names in the executor. */
export function createHostAgentTools(host: PluginHost, options: { allow?: readonly CapabilityRef[] } = {}): AgentTool[] {
  return host.listCapabilities().filter((capability) => capability.agent !== undefined && (!options.allow
    || options.allow.some((ref) => ref.id === capability.id && ref.version === capability.version))).map((capability): AgentTool => {
    const metadata = capability.agent!;
    const schema = structuredClone(metadata.inputSchema) as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown> | undefined;
    const bindCase = properties !== undefined && Object.hasOwn(properties, 'caseId');
    const bindOperation = properties !== undefined && Object.hasOwn(properties, 'operationId');
    const bindRevision = properties !== undefined && Object.hasOwn(properties, 'expectedRevision');
    if (properties) { delete properties.caseId; delete properties.operationId; delete properties.expectedRevision; }
    if (Array.isArray(schema.required)) schema.required = schema.required.filter((key) => !['caseId', 'operationId', 'expectedRevision'].includes(String(key)));
    return {
      id: capability.id, version: capability.version, description: metadata.description, effect: metadata.effect,
      inputSchema: schema, provider: { ...capability.provider }, input: z.record(z.string(), z.json()),
      execute: async (input, context) => {
        if (bindRevision && context.expectedCaseRevision === undefined) {
          throw new AgentToolError('TOOL_REVISION_REQUIRED', 'A write revision must come from the execution context, not model arguments.');
        }
        const parameters = { ...input as Record<string, unknown>, ...(bindCase ? { caseId: context.caseId } : {}), ...(bindOperation ? { operationId: context.operationId } : {}),
          ...(bindRevision && context.expectedCaseRevision !== undefined ? { expectedRevision: context.expectedCaseRevision } : {}) };
        const result = await host.invoke({ id: capability.id, version: capability.version }, parameters);
        if (result.status === 'error') throw new AgentToolError('TOOL_CAPABILITY_FAILED', `${result.error.code}: ${result.error.message}`);
        return result.status === 'success' ? result.data : { status: result.status, reason: result.reason };
      },
    };
  });
}
