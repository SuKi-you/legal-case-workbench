import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHost,
  defineCapability,
  HostError,
  type CapabilityContext,
  type CapabilityDefinition,
  type InvocationResult,
  type PluginDefinition,
} from '../src/index.ts';
import { numberSchema, numericCapability, plugin, schema, unknownSchema } from './helpers.ts';

const DOUBLE = { id: 'test.double', version: 1 } as const;

function assertError(result: InvocationResult, code: string, stage?: 'input' | 'output') {
  assert.equal(result.status, 'error');
  if (result.status !== 'error') assert.fail('Expected an error result');
  assert.equal(result.error.code, code);
  if (stage !== undefined) assert.equal(result.error.stage, stage);
  assert.ok(result.meta.callId.length > 0);
}

test('one caller replaces its provider solely through the plugin configuration', async () => {
  const configurations = [
    plugin('provider.multiply', [numericCapability(DOUBLE, (input) => input * 2)], { version: '1.2.0' }),
    plugin('provider.add', [numericCapability(DOUBLE, async (input) => input + input)], { version: '2.0.0' }),
  ];
  const caller = (host: Awaited<ReturnType<typeof createHost>>) => host.invoke(DOUBLE, 12);

  for (const selectedProvider of configurations) {
    const host = await createHost({ plugins: [selectedProvider] });
    try {
      const result = await caller(host);
      assert.equal(result.status, 'success');
      if (result.status !== 'success') assert.fail('Expected the selected implementation to work');
      assert.equal(result.data, 24);
      assert.deepEqual(result.meta.capability, DOUBLE);
      assert.deepEqual(result.meta.provider, {
        id: selectedProvider.manifest.id,
        version: selectedProvider.manifest.version,
      });
      assert.deepEqual(host.listCapabilities(), [{ ...DOUBLE, provider: result.meta.provider }]);
    } finally {
      await host.stop();
    }
  }
});

test('every startup configuration is checked before any setup is called', async (t) => {
  const OTHER = { id: 'test.other', version: 1 } as const;
  const cases: Array<{
    name: string;
    code: string;
    definitions: () => PluginDefinition[];
  }> = [
    {
      name: 'duplicate plugin identity',
      code: 'DUPLICATE_PLUGIN',
      definitions: () => [plugin('same', [numericCapability(DOUBLE)]), plugin('same', [numericCapability(OTHER)])],
    },
    {
      name: 'ambiguous capability providers',
      code: 'CAPABILITY_CONFLICT',
      definitions: () => [plugin('first', [numericCapability(DOUBLE)]), plugin('second', [numericCapability(DOUBLE)])],
    },
    {
      name: 'missing declared capability',
      code: 'DEPENDENCY_MISSING',
      definitions: () => [plugin('consumer', [numericCapability(OTHER)], { requires: [DOUBLE] })],
    },
    {
      name: 'dependency contract versions must match exactly',
      code: 'CONTRACT_VERSION_MISMATCH',
      definitions: () => [
        plugin('provider', [numericCapability(DOUBLE)]),
        plugin('consumer', [numericCapability(OTHER)], { requires: [{ ...DOUBLE, version: 2 }] }),
      ],
    },
    {
      name: 'cyclic capability dependencies',
      code: 'DEPENDENCY_CYCLE',
      definitions: () => [
        plugin('first', [numericCapability(DOUBLE)], { requires: [OTHER] }),
        plugin('second', [numericCapability(OTHER)], { requires: [DOUBLE] }),
      ],
    },
    {
      name: 'unsupported host API',
      code: 'API_VERSION_UNSUPPORTED',
      definitions: () => [{
        ...plugin('unsupported', [numericCapability(DOUBLE)]),
        manifest: { id: 'unsupported', version: '1.0.0', apiVersion: 2 },
      } as unknown as PluginDefinition],
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const started: string[] = [];
      const definitions = scenario.definitions().map((definition) => ({
        ...definition,
        setup() { started.push(definition.manifest.id); },
      }));
      await assert.rejects(createHost({ plugins: definitions }), (error: unknown) => {
        assert.ok(error instanceof HostError);
        assert.equal(error.code, scenario.code);
        return true;
      });
      assert.deepEqual(started, []);
    });
  }
});

test('Standard Schema transformations and asynchronous validation define the actual values', async () => {
  const input = schema<string, number>(async (value) => (
    typeof value === 'string' && /^\d+$/.test(value.trim())
      ? { value: Number(value.trim()) }
      : { issues: [{ message: 'Expected digits' }] }
  ));
  const output = schema<number, string>(async (value) => (
    typeof value === 'number'
      ? { value: `answer:${value}` }
      : { issues: [{ message: 'Expected a numeric answer' }] }
  ));
  let received: unknown;
  const capability = defineCapability({
    id: 'test.transform', version: 1, input, output,
    execute(value) {
      received = value;
      return { status: 'success', data: value * 3 };
    },
  });
  const host = await createHost({ plugins: [plugin('transformer', [capability])] });
  try {
    const result = await host.invoke(capability, ' 7 ');
    assert.equal(received, 7);
    assert.equal(result.status, 'success');
    if (result.status === 'success') assert.equal(result.data, 'answer:21');
  } finally {
    await host.stop();
  }
});

test('callable Standard Schema implementations use their standard validation interface', async () => {
  const callable = Object.assign(() => { assert.fail('The schema carrier itself must not be called'); }, numberSchema);
  const capability = defineCapability({
    ...DOUBLE, input: callable, output: callable,
    execute: (value) => ({ status: 'success', data: value * 2 }),
  });
  const host = await createHost({ plugins: [plugin('callable-schema', [capability])] });
  try {
    const result = await host.invoke(DOUBLE, 4);
    assert.equal(result.status, 'success');
    if (result.status === 'success') assert.equal(result.data, 8);
  } finally {
    await host.stop();
  }
});

test('invalid input never executes a capability, and invalid output is not a success', async () => {
  let calls = 0;
  const invalidOutput = defineCapability({
    ...DOUBLE, input: numberSchema, output: numberSchema,
    execute() {
      calls += 1;
      return { status: 'success', data: 'wrong type' as unknown as number };
    },
  });
  const host = await createHost({ plugins: [plugin('invalid-output', [invalidOutput])] });
  try {
    assertError(await host.invoke(DOUBLE, 'not a number'), 'INPUT_INVALID', 'input');
    assert.equal(calls, 0);
    assertError(await host.invoke(DOUBLE, 1), 'OUTPUT_INVALID', 'output');
    assert.equal(calls, 1);
  } finally {
    await host.stop();
  }
});

test('validator failures, execution failures, and malformed outcome envelopes remain distinguishable', async (t) => {
  const throwingSchema = schema<unknown>(() => { throw new Error('validator crashed'); });
  const definitions: Array<{ name: string; capability: CapabilityDefinition; code: string; stage?: 'input' | 'output' }> = [
    {
      name: 'input validator throws', code: 'VALIDATOR_FAILED', stage: 'input',
      capability: defineCapability({ ...DOUBLE, input: throwingSchema, output: unknownSchema, execute: () => ({ status: 'success', data: 1 }) }),
    },
    {
      name: 'output validator throws', code: 'VALIDATOR_FAILED', stage: 'output',
      capability: defineCapability({ ...DOUBLE, input: unknownSchema, output: throwingSchema, execute: () => ({ status: 'success', data: 1 }) }),
    },
    {
      name: 'handler rejects', code: 'EXECUTION_FAILED',
      capability: defineCapability({ ...DOUBLE, input: numberSchema, output: numberSchema, execute: async () => { throw new Error('execution failed'); } }),
    },
    {
      name: 'handler returns an unknown outcome', code: 'INVALID_RESULT',
      capability: { ...DOUBLE, input: numberSchema, output: numberSchema, execute: () => ({ status: 'unknown' }) } as unknown as CapabilityDefinition,
    },
  ];
  for (const scenario of definitions) {
    await t.test(scenario.name, async () => {
      const host = await createHost({ plugins: [plugin('failing-handler', [scenario.capability])] });
      try {
        assertError(await host.invoke(DOUBLE, 1), scenario.code, scenario.stage);
      } finally {
        await host.stop();
      }
    });
  }
});

test('needs_input and not_applicable are domain outcomes and do not validate nonexistent data', async (t) => {
  for (const status of ['needs_input', 'not_applicable'] as const) {
    await t.test(status, async () => {
      const output = schema<unknown>(() => { assert.fail('No success data exists to validate'); });
      const capability = defineCapability({
        ...DOUBLE, input: numberSchema, output,
        execute: () => ({ status, reason: 'A deliberate domain result' }),
      });
      const host = await createHost({ plugins: [plugin('domain-outcome', [capability])] });
      try {
        const result = await host.invoke(DOUBLE, 1);
        assert.equal(result.status, status);
        if (result.status === status) assert.equal(result.reason, 'A deliberate domain result');
      } finally {
        await host.stop();
      }
    });
  }
});

test('missing and mismatched invocations return errors instead of throwing', async () => {
  const host = await createHost({ plugins: [plugin('provider', [numericCapability(DOUBLE)])] });
  try {
    assertError(await host.invoke({ id: 'test.missing', version: 1 }, 2), 'CAPABILITY_NOT_FOUND');
    assertError(await host.invoke({ ...DOUBLE, version: 2 }, 2), 'CONTRACT_VERSION_MISMATCH');
    const first = await host.invoke(DOUBLE, 2);
    const second = await host.invoke(DOUBLE, 2);
    assert.notEqual(first.meta.callId, second.meta.callId);
  } finally {
    await host.stop();
  }
});

test('plugin calls require declared capabilities and retain parent-child invocation identity', async () => {
  const CALLER = { id: 'test.caller', version: 1 } as const;
  let nested: InvocationResult | undefined;
  const makeCaller = (declared: boolean) => plugin('consumer', [defineCapability({
    ...CALLER, input: numberSchema, output: numberSchema,
    async execute(input, context) {
      nested = await context.invoke(DOUBLE, input);
      return { status: 'success', data: 0 };
    },
  })], declared ? { requires: [DOUBLE] } : {});

  for (const declared of [false, true]) {
    const host = await createHost({ plugins: [makeCaller(declared), plugin('provider', [numericCapability(DOUBLE, (input) => input * 2)])] });
    try {
      const root = await host.invoke(CALLER, 4);
      assert.equal(root.status, 'success');
      assert.ok(nested);
      assert.equal(nested.meta.parentCallId, root.meta.callId);
      assert.notEqual(nested.meta.callId, root.meta.callId);
      if (declared) {
        assert.equal(nested.status, 'success');
        if (nested.status === 'success') assert.equal(nested.data, 8);
        assert.equal(nested.meta.provider?.id, 'provider');
      } else {
        assertError(nested, 'UNDECLARED_DEPENDENCY');
      }
    } finally {
      await host.stop();
    }
  }
});

test('a retained execution context cannot start work after its owning call settles', async () => {
  const CALLER = { id: 'test.capture-context', version: 1 } as const;
  let retained: CapabilityContext | undefined;
  const host = await createHost({ plugins: [
    plugin('consumer', [defineCapability({
      ...CALLER, input: numberSchema, output: numberSchema,
      execute(input, context) {
        retained = context;
        return { status: 'success', data: input };
      },
    })], { requires: [DOUBLE] }),
    plugin('provider', [numericCapability(DOUBLE)]),
  ] });
  try {
    const result = await host.invoke(CALLER, 1);
    assert.equal(result.status, 'success');
    assert.ok(retained);
    assertError(await retained.invoke(DOUBLE, 1), 'CALL_CONTEXT_CLOSED');
  } finally {
    await host.stop();
  }
});

test('an unprintable thrown value still becomes a uniform invocation error', async () => {
  const host = await createHost({ plugins: [plugin('provider', [numericCapability(DOUBLE, () => {
    throw Object.create(null);
  })])] });
  try {
    const result = await host.invoke(DOUBLE, 1);
    assertError(result, 'EXECUTION_FAILED');
    if (result.status === 'error') assert.equal(result.error.message, 'Unprintable thrown value.');
  } finally {
    await host.stop();
  }
});
