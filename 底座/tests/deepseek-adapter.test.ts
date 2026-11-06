import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { createDeepSeekModel, DeepSeekError, loadDeepSeekConfig } from '../src/information/deepseek.ts';

const key = 'fictional-local-test-token';
const prompt = { system: 'Extract source-grounded information.', user: '虚构材料，仅测试本地服务。' };
const hasCode = (code: string) => (error: unknown) => error instanceof DeepSeekError && error.code === code;
function answer(response: ServerResponse, content: unknown = { items: [] }, finish = 'stop') {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: finish }] }));
}
async function serverFor(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => { response.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') assert.fail('Expected an ephemeral loopback server.');
  return `http://127.0.0.1:${address.port}`;
}
async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('DeepSeek transport uses the configured base path, JSON mode and local credentials without changing the port', async (t) => {
  const received: { path: string; authorization: string | undefined; body: unknown }[] = [];
  const baseUrl = await serverFor(t, async (request, response) => {
    received.push({ path: request.url!, authorization: request.headers.authorization, body: await bodyOf(request) });
    answer(response, { result: '保留否定和相对时间', records: [] });
  });
  const model = createDeepSeekModel({ apiKey: key, baseUrl: `${baseUrl}/v1/`, model: 'configured-model', timeoutMs: 2000 });
  assert.equal(model.id, 'deepseek-json@1');
  assert.equal(model.model, 'configured-model');
  assert.deepEqual(await model.complete(prompt), { result: '保留否定和相对时间', records: [] });
  assert.equal(received.length, 1);
  assert.equal(received[0]!.path, '/v1/chat/completions');
  assert.equal(received[0]!.authorization, `Bearer ${key}`);
  const body = received[0]!.body as Record<string, unknown>;
  assert.equal(body.model, 'configured-model');
  assert.equal(body.stream, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.temperature, 0);
  assert.equal('reasoning_effort' in body, false);
  const messages = body.messages as { role: string; content: string }[];
  assert.match(messages[0]!.content, /json/iu);
  assert.equal(messages[1]!.content, prompt.user);
  assert.equal(JSON.stringify(model).includes(key), false);
});

test('high-reasoning requests enable thinking and return only the final JSON answer', async (t) => {
  const received: Record<string, unknown>[] = [];
  const privateReasoning = 'Intermediate reasoning is not the final answer: {"accepted":false,"hidden":"reasoning-only"}';
  const baseUrl = await serverFor(t, async (request, response) => {
    received.push(await bodyOf(request) as Record<string, unknown>);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: {
      role: 'assistant', reasoning_content: privateReasoning,
      content: JSON.stringify({ accepted: true, verdicts: [] }),
    }, finish_reason: 'stop' }] }));
  });
  const result = await createDeepSeekModel({ apiKey: key, baseUrl, timeoutMs: 2000 })
    .complete({ ...prompt, reasoning: 'high' });
  assert.deepEqual(result, { accepted: true, verdicts: [] });
  assert.equal(JSON.stringify(result).includes('reasoning-only'), false);
  assert.equal(received.length, 1);
  const body = received[0]!;
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal('temperature' in body, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.stream, false);
});

test('reasoning content cannot substitute for a missing final JSON answer', async (t) => {
  let requests = 0;
  const baseUrl = await serverFor(t, (_request, response) => {
    requests += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: {
      role: 'assistant', reasoning_content: '{"accepted":true,"verdicts":[]}', content: '',
    }, finish_reason: 'stop' }] }));
  });
  await assert.rejects(createDeepSeekModel({ apiKey: key, baseUrl, timeoutMs: 2000, maxRetries: 3 })
    .complete({ ...prompt, reasoning: 'high' }), hasCode('DEEPSEEK_EMPTY_CONTENT'));
  assert.equal(requests, 1);
});

test('project-specific configuration never falls back to another provider and rejects malformed settings', () => {
  const env: NodeJS.ProcessEnv = {
    DEEPSEEK_API_KEY: key, DEEPSEEK_MODEL: 'selected-model', DEEPSEEK_BASE_URL: 'https://example.invalid/v1', DEEPSEEK_TIMEOUT_MS: '1234',
  };
  Object.defineProperty(env, 'ANTHROPIC_AUTH_TOKEN', { get() { assert.fail('Other provider credentials must never be accessed.'); } });
  const config = loadDeepSeekConfig(env);
  assert.equal(config.apiKey, key);
  assert.equal(config.model, 'selected-model');
  assert.equal(config.baseUrl, 'https://example.invalid/v1');
  assert.equal(config.timeoutMs, 1234);
  const defaults = loadDeepSeekConfig({ DEEPSEEK_API_KEY: key });
  assert.equal(defaults.model, 'deepseek-flash');
  assert.equal(defaults.baseUrl, 'https://api.deepseek.com');
  assert.throws(() => loadDeepSeekConfig({}), hasCode('DEEPSEEK_KEY_MISSING'));
  assert.throws(() => loadDeepSeekConfig({ ANTHROPIC_AUTH_TOKEN: key }), hasCode('DEEPSEEK_KEY_MISSING'));
  for (const timeout of ['0', '-1', 'Infinity', '1e3', '300001', 'not-a-number']) {
    assert.throws(() => loadDeepSeekConfig({ DEEPSEEK_API_KEY: key, DEEPSEEK_TIMEOUT_MS: timeout }), hasCode('DEEPSEEK_CONFIG_INVALID'));
  }
  for (const options of [{ apiKey: '' }, { apiKey: `token\n${key}` }, { apiKey: key, maxRetries: 4 }, { apiKey: key, timeoutMs: NaN }]) {
    assert.throws(() => createDeepSeekModel(options), hasCode('DEEPSEEK_CONFIG_INVALID'));
  }
});

test('untrusted URLs cannot introduce credentials, redirects, queries or non-loopback plaintext transport', () => {
  for (const baseUrl of [
    'https://user:password@example.invalid', 'https://example.invalid/?key=hidden', 'https://example.invalid/#fragment',
    'http://example.invalid', 'http://localhost.example.invalid', 'file:///local/file', 'data:text/plain,x', 'javascript:alert(1)', 'not a URL',
  ]) assert.throws(() => createDeepSeekModel({ apiKey: key, baseUrl }), hasCode('DEEPSEEK_CONFIG_INVALID'));
  // These instantiate configuration only; no connection is opened.
  assert.equal(createDeepSeekModel({ apiKey: key, baseUrl: 'http://[::1]:8080/v1' }).model, 'deepseek-flash');
});

test('blank, malformed, non-object and truncated assistant answers fail without exposing returned content', async (t) => {
  const cases = [
    { content: '   ', finish: 'stop', code: 'DEEPSEEK_EMPTY_CONTENT' },
    { content: `secret server text ${key}`, finish: 'stop', code: 'DEEPSEEK_JSON_INVALID' },
    { content: '{"items":', finish: 'length', code: 'DEEPSEEK_TRUNCATED' },
    { content: '{}', finish: 'tool_calls', code: 'DEEPSEEK_RESPONSE_INCOMPLETE' },
    { content: '[]', finish: 'stop', code: 'DEEPSEEK_JSON_INVALID' },
  ];
  for (const item of cases) await t.test(item.code, async (child) => {
    let requests = 0;
    const baseUrl = await serverFor(child, (_request, response) => {
      requests += 1;
      response.end(JSON.stringify({ choices: [{ message: { content: item.content }, finish_reason: item.finish }] }));
    });
    const model = createDeepSeekModel({ apiKey: key, baseUrl, maxRetries: 3, timeoutMs: 2000 });
    await assert.rejects(model.complete(prompt), (error) => {
      assert.equal(hasCode(item.code)(error), true);
      assert.equal(String(error).includes(key), false);
      assert.equal(String(error).includes(prompt.user), false);
      return true;
    });
    assert.equal(requests, 1, 'Invalid answers are not retried as transient connection failures.');
  });
});

test('HTTP authentication errors and invalid envelopes are sanitized and are not retried', async (t) => {
  for (const status of [401, 403, 200]) await t.test(String(status), async (child) => {
    let requests = 0;
    const baseUrl = await serverFor(child, (_request, response) => {
      requests += 1;
      response.writeHead(status);
      response.end(`server echo ${key} ${prompt.user}`);
    });
    await assert.rejects(createDeepSeekModel({ apiKey: key, baseUrl, maxRetries: 3 }).complete(prompt), (error) => {
      assert.ok(error instanceof DeepSeekError);
      assert.equal(error.code, status === 200 ? 'DEEPSEEK_RESPONSE_INVALID' : 'DEEPSEEK_HTTP_ERROR');
      assert.equal(error.message.includes(key), false);
      assert.equal(error.message.includes(prompt.user), false);
      return true;
    });
    assert.equal(requests, 1);
  });
});

test('transient HTTP failures retry within a finite budget while network resets can recover', async (t) => {
  for (const firstStatus of [429, 503, 'reset'] as const) await t.test(String(firstStatus), async (child) => {
    let requests = 0;
    const baseUrl = await serverFor(child, (request, response) => {
      requests += 1;
      if (requests === 1) {
        if (firstStatus === 'reset') { request.socket.destroy(); return; }
        response.writeHead(firstStatus); response.end('retry'); return;
      }
      answer(response, { recovered: true });
    });
    assert.deepEqual(await createDeepSeekModel({ apiKey: key, baseUrl, maxRetries: 1, timeoutMs: 2000 }).complete(prompt), { recovered: true });
    assert.equal(requests, 2);
  });
  let exhausted = 0;
  const baseUrl = await serverFor(t, (_request, response) => { exhausted += 1; response.writeHead(500); response.end('unavailable'); });
  await assert.rejects(createDeepSeekModel({ apiKey: key, baseUrl, maxRetries: 2, timeoutMs: 2000 }).complete(prompt), hasCode('DEEPSEEK_HTTP_ERROR'));
  assert.equal(exhausted, 3);
});

test('the overall deadline also bounds an unfinished response body and retry delays', { timeout: 5000 }, async (t) => {
  const baseUrl = await serverFor(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"choices":'); // Headers arrive, but the response body never ends.
  });
  await assert.rejects(createDeepSeekModel({ apiKey: key, baseUrl, timeoutMs: 80, maxRetries: 3 }).complete(prompt), hasCode('DEEPSEEK_TIMEOUT'));
  let requests = 0;
  const busy = await serverFor(t, (_request, response) => { requests += 1; response.writeHead(429); response.end('busy'); });
  await assert.rejects(createDeepSeekModel({ apiKey: key, baseUrl: busy, timeoutMs: 30, maxRetries: 3 }).complete(prompt), hasCode('DEEPSEEK_TIMEOUT'));
  assert.equal(requests, 1);
});

test('caller cancellation works before sending, during a body and during retry backoff without echoing its reason', { timeout: 5000 }, async (t) => {
  let requests = 0;
  const baseUrl = await serverFor(t, (_request, response) => { requests += 1; response.writeHead(200); response.write('{'); });
  const before = new AbortController(); before.abort(`private reason ${key}`);
  const model = createDeepSeekModel({ apiKey: key, baseUrl, timeoutMs: 2000 });
  await assert.rejects(model.complete({ ...prompt, signal: before.signal }), hasCode('DEEPSEEK_CANCELLED'));
  assert.equal(requests, 0);
  const during = new AbortController();
  const pending = model.complete({ ...prompt, signal: during.signal });
  const observed = assert.rejects(pending, (error) => {
    assert.equal(hasCode('DEEPSEEK_CANCELLED')(error), true);
    assert.equal(String(error).includes(key), false); return true;
  });
  setTimeout(() => during.abort(key), 30);
  await observed;
  const backoff = new AbortController();
  let retries = 0;
  const busy = await serverFor(t, (_request, response) => { retries += 1; response.writeHead(503); response.end(); setTimeout(() => backoff.abort(key), 10); });
  await assert.rejects(createDeepSeekModel({ apiKey: key, baseUrl: busy, timeoutMs: 2000, maxRetries: 3 })
    .complete({ ...prompt, signal: backoff.signal }), hasCode('DEEPSEEK_CANCELLED'));
  assert.equal(retries, 1);
});

test('endpoint redirects are never followed and do not forward authorization to the destination', async (t) => {
  let destinations = 0;
  const destination = await serverFor(t, (_request, response) => { destinations += 1; answer(response); });
  let redirects = 0;
  const baseUrl = await serverFor(t, (_request, response) => {
    redirects += 1; response.writeHead(307, { Location: `${destination}/capture` }); response.end();
  });
  await assert.rejects(createDeepSeekModel({ apiKey: key, baseUrl, maxRetries: 3 }).complete(prompt), hasCode('DEEPSEEK_REDIRECT_REJECTED'));
  assert.equal(redirects, 1);
  assert.equal(destinations, 0);
});

test('oversized response bodies are rejected even with no declared content length', async (t) => {
  const baseUrl = await serverFor(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"padding":"');
    response.end('x'.repeat(2 * 1024 * 1024 + 1));
  });
  await assert.rejects(createDeepSeekModel({ apiKey: key, baseUrl, timeoutMs: 2000 }).complete(prompt), hasCode('DEEPSEEK_RESPONSE_TOO_LARGE'));
});
