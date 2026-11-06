import type { StandardSchemaV1 } from '@standard-schema/spec';
import { HOST_API_VERSION } from './contracts.ts';
import type {
  CapabilityDefinition, CapabilityRef, HostOptions, PluginDefinition,
  AgentCapabilityMetadata,
} from './contracts.ts';
import { HostError } from './errors.ts';

export interface Provider {
  readonly plugin: PluginDefinition;
  readonly capability: CapabilityDefinition;
}

export interface HostPlan {
  readonly orderedPlugins: readonly PluginDefinition[];
  readonly providers: ReadonlyMap<string, Provider>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

export function isCapabilityRef(value: unknown): value is CapabilityRef {
  return isRecord(value) && isName(value.id)
    && Number.isSafeInteger(value.version) && (value.version as number) > 0;
}

function isSchema(value: unknown): value is StandardSchemaV1 {
  if (!isRecord(value) && typeof value !== 'function') return false;
  const standard: unknown = Reflect.get(value, '~standard');
  if (!isRecord(standard)) return false;
  return standard.version === 1 && isName(standard.vendor)
    && typeof standard.validate === 'function';
}

function snapshotAgent(value: AgentCapabilityMetadata | undefined): AgentCapabilityMetadata | undefined {
  if (value === undefined) return undefined;
  const json = (item: unknown, seen: Set<object>, depth: number): boolean => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || depth > 40 || seen.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    seen.add(item);
    const valid = Object.values(item).every((entry) => json(entry, seen, depth + 1));
    seen.delete(item); return valid;
  };
  if (!isRecord(value) || typeof value.description !== 'string' || !value.description.trim()
    || !['read', 'write'].includes(value.effect) || !isRecord(value.inputSchema) || Array.isArray(value.inputSchema)
    || !json(value.inputSchema, new Set(), 0) || JSON.stringify(value.inputSchema).length > 131072) {
    throw new HostError('CONFIG_INVALID', 'Agent metadata requires a description, JSON parameter schema and read/write effect.');
  }
  return Object.freeze({ description: value.description, inputSchema: structuredClone(value.inputSchema), effect: value.effect });
}

/** Snapshot configuration before any setup code can acquire resources or mutate it. */
function snapshot(plugin: PluginDefinition): PluginDefinition {
  if (!isRecord(plugin) || !isRecord(plugin.manifest)) {
    throw new HostError('CONFIG_INVALID', 'Plugin must have a manifest.');
  }
  const manifest = plugin.manifest;
  if (!isName(manifest.id) || !isName(manifest.version)) {
    throw new HostError('CONFIG_INVALID', 'Plugin id and version must be non-empty strings.');
  }
  if (manifest.apiVersion !== HOST_API_VERSION) {
    throw new HostError('API_VERSION_UNSUPPORTED', `${manifest.id}: host API must be ${HOST_API_VERSION}.`);
  }
  if (!Array.isArray(plugin.capabilities)
    || (plugin.setup !== undefined && typeof plugin.setup !== 'function')
    || (manifest.requires !== undefined && !Array.isArray(manifest.requires))) {
    throw new HostError('CONFIG_INVALID', `${manifest.id}: invalid capabilities, setup or requires.`);
  }
  const requires: CapabilityRef[] = [];
  for (const ref of manifest.requires ?? []) {
    if (!isCapabilityRef(ref) || requires.some((item) => item.id === ref.id)) {
      throw new HostError('CONFIG_INVALID', `${manifest.id}: invalid or duplicate capability dependency.`);
    }
    requires.push(Object.freeze({ id: ref.id, version: ref.version }));
  }
  const capabilities = plugin.capabilities.map((capability: CapabilityDefinition) => {
    if (!isCapabilityRef(capability) || !isSchema(capability.input)
      || !isSchema(capability.output) || typeof capability.execute !== 'function') {
      throw new HostError('CONFIG_INVALID', `${manifest.id}: invalid capability definition.`);
    }
    const agent = snapshotAgent(capability.agent);
    return Object.freeze({
      id: capability.id,
      version: capability.version,
      input: capability.input,
      output: capability.output,
      execute: capability.execute,
      ...(agent ? { agent } : {}),
    });
  });
  return Object.freeze({
    manifest: Object.freeze({
      id: manifest.id,
      version: manifest.version,
      apiVersion: HOST_API_VERSION,
      requires: Object.freeze(requires),
    }),
    capabilities: Object.freeze(capabilities),
    ...(plugin.setup ? { setup: plugin.setup } : {}),
  });
}

/** All configuration checks finish before any plugin is activated. */
export function planHost(options: HostOptions): HostPlan {
  if (!options || !Array.isArray(options.plugins)) {
    throw new HostError('CONFIG_INVALID', 'Host options must contain a plugins array.');
  }
  const plugins = options.plugins.map(snapshot);
  const ids = new Set<string>();
  const providers = new Map<string, Provider>();
  for (const plugin of plugins) {
    const { id } = plugin.manifest;
    if (ids.has(id)) throw new HostError('DUPLICATE_PLUGIN', `Duplicate plugin: ${id}.`);
    ids.add(id);
    for (const capability of plugin.capabilities) {
      if (providers.has(capability.id)) {
        throw new HostError('CAPABILITY_CONFLICT', `Multiple providers for ${capability.id}; select one in configuration.`);
      }
      providers.set(capability.id, { plugin, capability });
    }
  }
  for (const plugin of plugins) {
    for (const ref of plugin.manifest.requires ?? []) {
      const provider = providers.get(ref.id);
      if (!provider) {
        throw new HostError('DEPENDENCY_MISSING', `${plugin.manifest.id} requires ${ref.id}@${ref.version}.`);
      }
      if (provider.capability.version !== ref.version) {
        throw new HostError('CONTRACT_VERSION_MISMATCH', `${plugin.manifest.id} requires ${ref.id}@${ref.version}, found @${provider.capability.version}.`);
      }
    }
  }

  const orderedPlugins: PluginDefinition[] = [];
  const visited = new Set<string>();
  const visiting: string[] = [];
  const visit = (plugin: PluginDefinition): void => {
    const { id } = plugin.manifest;
    if (visited.has(id)) return;
    if (visiting.includes(id)) {
      throw new HostError('DEPENDENCY_CYCLE', `Plugin dependency cycle: ${[...visiting, id].join(' -> ')}.`);
    }
    visiting.push(id);
    for (const ref of plugin.manifest.requires ?? []) {
      visit(providers.get(ref.id)!.plugin);
    }
    visiting.pop();
    visited.add(id);
    orderedPlugins.push(plugin);
  };
  plugins.forEach(visit);
  return { orderedPlugins, providers };
}
