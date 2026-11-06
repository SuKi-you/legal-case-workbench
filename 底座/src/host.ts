import { randomUUID } from 'node:crypto';
import type {
  CapabilityContext, CapabilityDescription, CapabilityRef, HostOptions,
  InvocationError, InvocationMeta, InvocationResult, MaybePromise,
  PluginDefinition, PluginHost, StopResult,
} from './contracts.ts';
import { HostError } from './errors.ts';
import { isCapabilityRef, isRecord, planHost } from './plan.ts';
import type { HostPlan } from './plan.ts';
import { errorMessage, validate } from './validation.ts';

interface ResourceScope {
  readonly pluginId: string;
  readonly disposers: (() => MaybePromise<void>)[];
  accepting: boolean;
}

function failure(meta: InvocationMeta, error: InvocationError): InvocationResult {
  return { status: 'error', error, meta };
}

class Host implements PluginHost {
  #state: PluginHost['state'] = 'starting';
  readonly #plan: HostPlan;
  readonly #scopes: ResourceScope[] = [];
  #activeCalls = 0;
  #onDrained: (() => void) | undefined;
  #stopPromise: Promise<StopResult> | undefined;

  constructor(plan: HostPlan) {
    this.#plan = plan;
  }

  get state(): PluginHost['state'] { return this.#state; }

  async start(): Promise<void> {
    let activating = '';
    try {
      for (const plugin of this.#plan.orderedPlugins) {
        activating = plugin.manifest.id;
        const scope: ResourceScope = { pluginId: activating, disposers: [], accepting: true };
        this.#scopes.push(scope);
        try {
          await plugin.setup?.({
            onDispose(dispose) {
              if (!scope.accepting || typeof dispose !== 'function') {
                throw new Error('Disposers must be registered as functions during setup.');
              }
              scope.disposers.push(dispose);
            },
          });
        } finally {
          scope.accepting = false;
        }
      }
      this.#state = 'ready';
    } catch (error) {
      const cleanupErrors = await this.#cleanup();
      this.#state = 'stopped';
      throw new HostError('PLUGIN_START_FAILED', `${activating}: ${errorMessage(error)}`, {
        pluginId: activating,
        cleanupErrors,
      });
    }
  }

  listCapabilities(): readonly CapabilityDescription[] {
    return [...this.#plan.providers.values()].map(({ capability, plugin }) => ({
      id: capability.id,
      version: capability.version,
      provider: { id: plugin.manifest.id, version: plugin.manifest.version },
      ...(capability.agent ? { agent: structuredClone(capability.agent) } : {}),
    }));
  }

  invoke(ref: CapabilityRef, input: unknown): Promise<InvocationResult> {
    const meta = this.#meta(ref);
    if (this.#state !== 'ready') {
      return Promise.resolve(failure(meta, {
        code: 'HOST_NOT_READY', message: `Host is ${this.#state}; new calls are not accepted.`,
      }));
    }
    return this.#dispatch(ref, input, meta);
  }

  stop(): Promise<StopResult> {
    if (!this.#stopPromise) {
      this.#state = 'stopping';
      // Store the shared promise before a disposer can synchronously re-enter stop().
      this.#stopPromise = Promise.resolve().then(() => this.#shutdown());
    }
    return this.#stopPromise;
  }

  #meta(ref: CapabilityRef, parentCallId?: string): InvocationMeta {
    const capability = isCapabilityRef(ref)
      ? Object.freeze({ id: ref.id, version: ref.version })
      : Object.freeze({ id: '<invalid>', version: 0 });
    const plugin = this.#plan.providers.get(capability.id)?.plugin;
    return Object.freeze({
      callId: randomUUID(),
      capability,
      ...(parentCallId ? { parentCallId } : {}),
      ...(plugin ? { provider: Object.freeze({ id: plugin.manifest.id, version: plugin.manifest.version }) } : {}),
    });
  }

  #dispatch(ref: CapabilityRef, input: unknown, meta: InvocationMeta): Promise<InvocationResult> {
    this.#activeCalls++;
    return this.#perform(ref, input, meta)
      .catch((error: unknown) => failure(meta, { code: 'EXECUTION_FAILED', message: errorMessage(error) }))
      .finally(() => {
        this.#activeCalls--;
        if (this.#activeCalls === 0) this.#onDrained?.();
      });
  }

  #context(plugin: PluginDefinition, meta: InvocationMeta, isOpen: () => boolean): CapabilityContext {
    return Object.freeze({
      callId: meta.callId,
      invoke: (ref: CapabilityRef, input: unknown) => {
        const childMeta = this.#meta(ref, meta.callId);
        if (!isOpen()) {
          return Promise.resolve(failure(childMeta, {
            code: 'CALL_CONTEXT_CLOSED', message: 'The originating call has finished.',
          }));
        }
        if (!isCapabilityRef(ref)) {
          return Promise.resolve(failure(childMeta, { code: 'CONFIG_INVALID', message: 'Invalid capability reference.' }));
        }
        const dependency = plugin.manifest.requires?.find((item) => item.id === ref.id);
        if (!dependency) {
          return Promise.resolve(failure(childMeta, {
            code: 'UNDECLARED_DEPENDENCY', message: `${plugin.manifest.id} did not declare ${ref.id}.`,
          }));
        }
        if (dependency.version !== ref.version) {
          return Promise.resolve(failure(childMeta, {
            code: 'CONTRACT_VERSION_MISMATCH', message: `${ref.id}: declared @${dependency.version}, requested @${ref.version}.`,
          }));
        }
        // Accepted calls may finish their dependency calls while stop() drains.
        return this.#dispatch(ref, input, childMeta);
      },
    });
  }

  async #perform(ref: CapabilityRef, input: unknown, meta: InvocationMeta): Promise<InvocationResult> {
    if (!isCapabilityRef(ref)) {
      return failure(meta, { code: 'CONFIG_INVALID', message: 'Invalid capability reference.' });
    }
    const provider = this.#plan.providers.get(ref.id);
    if (!provider) {
      return failure(meta, { code: 'CAPABILITY_NOT_FOUND', message: `No provider for ${ref.id}.` });
    }
    const { capability, plugin } = provider;
    if (capability.version !== ref.version) {
      return failure(meta, {
        code: 'CONTRACT_VERSION_MISMATCH', message: `${ref.id}: requested @${ref.version}, provided @${capability.version}.`,
      });
    }
    const parsedInput = await validate(capability.input, input, 'input');
    if (!parsedInput.ok) return failure(meta, parsedInput.error);

    let open = true;
    try {
      const outcome: unknown = await capability.execute(parsedInput.value, this.#context(plugin, meta, () => open));
      if (!isRecord(outcome)) {
        return failure(meta, { code: 'INVALID_RESULT', message: 'Capability did not return an outcome object.' });
      }
      if (outcome.status === 'success' && 'data' in outcome) {
        const parsedOutput = await validate(capability.output, outcome.data, 'output');
        return parsedOutput.ok
          ? { status: 'success', data: parsedOutput.value, meta }
          : failure(meta, parsedOutput.error);
      }
      if ((outcome.status === 'needs_input' || outcome.status === 'not_applicable')
        && typeof outcome.reason === 'string' && outcome.reason.trim().length > 0) {
        return { status: outcome.status, reason: outcome.reason, meta };
      }
      return failure(meta, { code: 'INVALID_RESULT', message: 'Capability returned an invalid status or payload.' });
    } catch (error) {
      return failure(meta, { code: 'EXECUTION_FAILED', message: errorMessage(error) });
    } finally {
      open = false;
    }
  }

  async #shutdown(): Promise<StopResult> {
    if (this.#activeCalls > 0) {
      await new Promise<void>((resolve) => { this.#onDrained = resolve; });
    }
    const cleanupErrors = await this.#cleanup();
    this.#onDrained = undefined;
    this.#state = 'stopped';
    return Object.freeze({ status: 'stopped', cleanupErrors: Object.freeze(cleanupErrors) });
  }

  async #cleanup(): Promise<{ pluginId: string; message: string }[]> {
    const errors: { pluginId: string; message: string }[] = [];
    for (const scope of [...this.#scopes].reverse()) {
      for (const dispose of [...scope.disposers].reverse()) {
        try { await dispose(); }
        catch (error) { errors.push({ pluginId: scope.pluginId, message: errorMessage(error) }); }
      }
      scope.disposers.length = 0;
    }
    this.#scopes.length = 0;
    return errors;
  }
}

export async function createHost(options: HostOptions): Promise<PluginHost> {
  const host = new Host(planHost(options));
  await host.start();
  return host;
}
