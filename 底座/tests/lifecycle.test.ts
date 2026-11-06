import assert from 'node:assert/strict';
import test from 'node:test';
import { createHost, defineCapability, HostError, type PluginHost } from '../src/index.ts';
import { deferred, numberSchema, numericCapability, plugin } from './helpers.ts';

const SOURCE = { id: 'test.source', version: 1 } as const;
const CONSUMER = { id: 'test.consumer', version: 1 } as const;

test('dependencies start before consumers and all cleanup follows reverse acquisition order', async () => {
  const events: string[] = [];
  const host = await createHost({ plugins: [
    plugin('consumer', [numericCapability(CONSUMER)], {
      requires: [SOURCE],
      setup({ onDispose }) {
        events.push('start consumer');
        onDispose(() => { events.push('dispose consumer first'); });
        onDispose(() => { events.push('dispose consumer second'); });
      },
    }),
    plugin('provider', [numericCapability(SOURCE)], {
      setup({ onDispose }) {
        events.push('start provider');
        onDispose(() => { events.push('dispose provider first'); });
        onDispose(() => { events.push('dispose provider second'); });
      },
    }),
  ] });
  assert.equal(host.state, 'ready');
  assert.deepEqual(events, ['start provider', 'start consumer']);
  const result = await host.stop();
  assert.deepEqual(result, { status: 'stopped', cleanupErrors: [] });
  assert.equal(host.state, 'stopped');
  assert.deepEqual(events, [
    'start provider', 'start consumer',
    'dispose consumer second', 'dispose consumer first',
    'dispose provider second', 'dispose provider first',
  ]);
});

test('a failed setup cleans its own partial acquisitions and preceding dependencies even when cleanup throws', async () => {
  const events: string[] = [];
  await assert.rejects(createHost({ plugins: [
    plugin('consumer', [numericCapability(CONSUMER)], {
      requires: [SOURCE],
      setup({ onDispose }) {
        events.push('start consumer');
        onDispose(() => { events.push('consumer earlier'); });
        onDispose(() => { events.push('consumer later'); throw new Error('cleanup failed'); });
        throw new Error('startup failed after resource acquisition');
      },
    }),
    plugin('provider', [numericCapability(SOURCE)], {
      setup({ onDispose }) {
        events.push('start provider');
        onDispose(async () => { events.push('provider cleanup'); });
      },
    }),
  ] }), (error: unknown) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.code, 'PLUGIN_START_FAILED');
    return true;
  });
  assert.deepEqual(events, [
    'start provider', 'start consumer', 'consumer later', 'consumer earlier', 'provider cleanup',
  ]);
});

test('stop reports cleanup failures, finishes the remaining cleanup, and is idempotent', async () => {
  const events: string[] = [];
  const cleanupStarted = deferred();
  const allowCleanup = deferred();
  const host = await createHost({ plugins: [plugin('provider', [numericCapability(SOURCE)], {
    setup({ onDispose }) {
      onDispose(() => { events.push('earliest'); });
      onDispose(() => { events.push('failure'); throw new Error('cannot release resource'); });
      onDispose(async () => {
        events.push('latest');
        cleanupStarted.resolve();
        await allowCleanup.promise;
      });
    },
  })] });

  const first = host.stop();
  await cleanupStarted.promise;
  const concurrent = host.stop();
  assert.equal(host.state, 'stopping');
  assert.deepEqual(events, ['latest']);
  allowCleanup.resolve();
  const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
  assert.deepEqual(firstResult, concurrentResult);
  assert.equal(firstResult.status, 'stopped');
  assert.equal(firstResult.cleanupErrors.length, 1);
  assert.equal(firstResult.cleanupErrors[0]?.pluginId, 'provider');
  assert.match(firstResult.cleanupErrors[0]?.message ?? '', /cannot release resource/);
  assert.deepEqual(events, ['latest', 'failure', 'earliest']);
  assert.deepEqual(await host.stop(), firstResult);
  assert.deepEqual(events, ['latest', 'failure', 'earliest']);
  const afterStop = await host.invoke(SOURCE, 1);
  assert.equal(afterStop.status, 'error');
  if (afterStop.status === 'error') assert.equal(afterStop.error.code, 'HOST_NOT_READY');
});

test('stop rejects new root calls but permits accepted calls to use declared dependencies before cleanup', { timeout: 5000 }, async () => {
  const rootStarted = deferred();
  const allowChildCall = deferred();
  const childStarted = deferred();
  const allowChildResult = deferred();
  const events: string[] = [];
  const host = await createHost({ plugins: [
    plugin('consumer', [defineCapability({
      ...CONSUMER, input: numberSchema, output: numberSchema,
      async execute(input, context) {
        rootStarted.resolve();
        await allowChildCall.promise;
        const child = await context.invoke(SOURCE, input);
        assert.equal(child.status, 'success');
        if (child.status !== 'success' || typeof child.data !== 'number') throw new Error('Child call was rejected');
        return { status: 'success', data: child.data + 1 };
      },
    })], {
      requires: [SOURCE],
      setup({ onDispose }) { onDispose(() => { events.push('consumer disposed'); }); },
    }),
    plugin('provider', [numericCapability(SOURCE, async (input) => {
      childStarted.resolve();
      await allowChildResult.promise;
      events.push('child finished');
      return input * 2;
    })], {
      setup({ onDispose }) { onDispose(() => { events.push('provider disposed'); }); },
    }),
  ] });

  const accepted = host.invoke(CONSUMER, 4);
  await rootStarted.promise;
  const stopping = host.stop();
  const newRoot = await host.invoke(SOURCE, 99);
  assert.equal(newRoot.status, 'error');
  if (newRoot.status === 'error') assert.equal(newRoot.error.code, 'HOST_NOT_READY');
  assert.deepEqual(events, []);
  allowChildCall.resolve();
  await childStarted.promise;
  assert.deepEqual(events, []);
  allowChildResult.resolve();
  const result = await accepted;
  assert.equal(result.status, 'success');
  if (result.status === 'success') assert.equal(result.data, 9);
  assert.deepEqual(await stopping, { status: 'stopped', cleanupErrors: [] });
  assert.deepEqual(events, ['child finished', 'consumer disposed', 'provider disposed']);
});

test('an already admitted child is drained even when its parent does not await it', { timeout: 5000 }, async () => {
  const childStarted = deferred();
  const allowChildResult = deferred();
  const events: string[] = [];
  let child: ReturnType<Awaited<ReturnType<typeof createHost>>['invoke']> | undefined;
  const host = await createHost({ plugins: [
    plugin('consumer', [defineCapability({
      ...CONSUMER, input: numberSchema, output: numberSchema,
      execute(input, context) {
        child = context.invoke(SOURCE, input);
        return { status: 'success', data: input };
      },
    })], { requires: [SOURCE] }),
    plugin('provider', [numericCapability(SOURCE, async (input) => {
      childStarted.resolve();
      await allowChildResult.promise;
      events.push('child finished');
      return input;
    })], {
      setup({ onDispose }) { onDispose(() => { events.push('provider disposed'); }); },
    }),
  ] });

  const root = await host.invoke(CONSUMER, 8);
  assert.equal(root.status, 'success');
  await childStarted.promise;
  const stopping = host.stop();
  assert.deepEqual(events, []);
  allowChildResult.resolve();
  assert.ok(child);
  assert.equal((await child).status, 'success');
  await stopping;
  assert.deepEqual(events, ['child finished', 'provider disposed']);
});

test('a disposer can re-enter stop without running cleanup twice', async () => {
  let host!: PluginHost;
  let calls = 0;
  let reentrant: ReturnType<PluginHost['stop']> | undefined;
  host = await createHost({ plugins: [plugin('provider', [numericCapability(SOURCE)], {
    setup({ onDispose }) {
      onDispose(() => {
        calls++;
        if (calls === 1) reentrant = host.stop();
      });
    },
  })] });
  const stopping = host.stop();
  const result = await stopping;
  assert.equal(calls, 1);
  assert.equal(reentrant, stopping);
  assert.deepEqual(result, { status: 'stopped', cleanupErrors: [] });
});

test('an unprintable thrown value cannot abort the remaining resource cleanup', async () => {
  const events: string[] = [];
  const host = await createHost({ plugins: [plugin('provider', [numericCapability(SOURCE)], {
    setup({ onDispose }) {
      onDispose(() => { events.push('released'); });
      onDispose(() => { throw Object.create(null); });
    },
  })] });
  const result = await host.stop();
  assert.equal(host.state, 'stopped');
  assert.equal(result.cleanupErrors[0]?.message, 'Unprintable thrown value.');
  assert.deepEqual(events, ['released']);
});
