import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDemoHost, loadDemoConfig } from '../examples/configuration.ts';
import { LOCATE_QUOTE, REPORT_QUOTE, quoteMatchSchema } from '../examples/contracts.ts';
import { runDemo } from '../examples/demo.ts';

const alternateConfig = fileURLToPath(new URL('../examples/configs/alternate.json', import.meta.url));

test('JSON configuration swaps implementations while consumer and UTF-16 source references stay unchanged', async () => {
  const request = { sourceId: 'fictional-unicode-material', text: '😀 测试材料：下周再联系。', quote: '下周再联系' };
  const providers: string[] = [];
  const consumers: string[] = [];
  const caller = (host: Awaited<ReturnType<typeof createDemoHost>>) => host.invoke(REPORT_QUOTE, request);
  for (const config of [await loadDemoConfig(), await loadDemoConfig(alternateConfig)]) {
    const host = await createDemoHost(config);
    try {
      const provider = host.listCapabilities().find((item) => item.id === LOCATE_QUOTE.id);
      assert.ok(provider);
      providers.push(provider.provider.id);
      const result = await caller(host);
      assert.equal(result.status, 'success');
      if (result.status !== 'success') assert.fail('Expected a located quote');
      consumers.push(result.meta.provider!.id);
      const located = quoteMatchSchema.parse(result.data);
      const start = request.text.indexOf(request.quote);
      assert.deepEqual(located, {
        sourceId: request.sourceId,
        quote: request.quote,
        start,
        end: start + request.quote.length,
      });
      assert.equal(request.text.slice(located.start, located.end), located.quote);
    } finally {
      assert.deepEqual(await host.stop(), { status: 'stopped', cleanupErrors: [] });
    }
  }
  assert.notEqual(providers[0], providers[1]);
  assert.equal(consumers[0], consumers[1]);
});

test('demo covers domain outcomes and validation errors, and releases the host for both configurations', async () => {
  for (const config of [await loadDemoConfig(), await loadDemoConfig(alternateConfig)]) {
    const report = await runDemo(config);
    assert.deepEqual(report.cases.map((item) => item.result.status), [
      'success', 'needs_input', 'not_applicable', 'error',
    ]);
    const invalid = report.cases[3]!.result;
    if (invalid.status !== 'error') assert.fail('Expected the invalid-input scenario to fail');
    assert.equal(invalid.error.code, 'INPUT_INVALID');
    assert.deepEqual(report.stopResult, { status: 'stopped', cleanupErrors: [] });
  }
});

test('an unknown configured provider is rejected rather than silently replaced', async () => {
  const path = fileURLToPath(new URL('./fixtures/invalid-provider.json', import.meta.url));
  await assert.rejects(loadDemoConfig(path));
});
