import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { createDeepSeekModel } from '../src/information/deepseek.ts';

async function endpoint(t: TestContext, respond: (attempt: number) => { status: number; body: unknown }) {
  let attempts = 0;
  const server = createServer((request, response) => {
    request.resume();
    const next = respond(++attempts);
    response.writeHead(next.status, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify(next.body));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const message = { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] };

test('transport reports provider token usage without changing its JSON result contract', async (t) => {
  const baseUrl = await endpoint(t, () => ({ status: 200,
    body: { ...message, usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } } }));
  const model = createDeepSeekModel({ apiKey: 'offline-fixture-token', baseUrl, maxRetries: 0 });
  assert.deepEqual(await model.complete({ system: 'json fixture', user: '{}' }), { ok: true });
  assert.deepEqual(model.getUsage(), { requests: 1, successfulJsonResponses: 1, providerUsageResponses: 1,
    promptTokens: 12, completionTokens: 5, totalTokens: 17 });
  assert.equal(Object.isFrozen(model.getUsage()), true);
});

test('HTTP retries are counted and absent provider usage remains distinguishable from a reported zero', async (t) => {
  const baseUrl = await endpoint(t, attempt => attempt === 1 ? { status: 429, body: {} } : { status: 200, body: message });
  const model = createDeepSeekModel({ apiKey: 'offline-fixture-token', baseUrl, maxRetries: 1 });
  await model.complete({ system: 'json fixture', user: '{}' });
  assert.equal(model.getUsage().requests, 2); assert.equal(model.getUsage().successfulJsonResponses, 1);
  assert.equal(model.getUsage().providerUsageResponses, 0);
});
