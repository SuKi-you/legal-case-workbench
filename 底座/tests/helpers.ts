import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  defineCapability,
  type CapabilityDefinition,
  type CapabilityRef,
  type PluginDefinition,
} from '../src/index.ts';

export function schema<Input, Output = Input>(
  validate: (value: unknown) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<Input, Output> {
  return { '~standard': { version: 1, vendor: 'independent-host-tests', validate } };
}

export const numberSchema = schema<number>((value) => (
  typeof value === 'number' && Number.isFinite(value)
    ? { value }
    : { issues: [{ message: 'Expected a finite number' }] }
));

export const unknownSchema = schema<unknown>((value) => ({ value }));

export function plugin(
  id: string,
  capabilities: readonly CapabilityDefinition[],
  options: {
    requires?: readonly CapabilityRef[];
    setup?: PluginDefinition['setup'];
    version?: string;
  } = {},
): PluginDefinition {
  return {
    manifest: {
      id,
      version: options.version ?? '1.0.0',
      apiVersion: 1,
      ...(options.requires === undefined ? {} : { requires: options.requires }),
    },
    capabilities,
    ...(options.setup === undefined ? {} : { setup: options.setup }),
  };
}

export function numericCapability(
  ref: CapabilityRef,
  execute: (input: number) => number | Promise<number> = (input) => input,
): CapabilityDefinition {
  return defineCapability({
    ...ref,
    input: numberSchema,
    output: numberSchema,
    execute: async (input) => ({ status: 'success', data: await execute(input) }),
  });
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
