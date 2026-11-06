import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadHostedAccess } from '../server/hosted.mjs';
import { createWorkbenchServer } from '../server/index.mjs';

const domain = 'workbench.example.test';
const publicOrigin = 'https://' + domain;
const firstPassword = 'synthetic-password-for-alice-only';
const secondPassword = 'synthetic-password-for-bob-only';
const basic = (username, password) => 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
const alice = basic('alice', firstPassword);
const bob = basic('bob', secondPassword);
const safeHeaders = { host: domain, 'x-forwarded-proto': 'https' };

function account(password, salt) {
  return { salt, hash: scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex') };
}

async function temporaryWorkspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'law-web-hosted-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^law-web-hosted-test-/u);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function listen(options) {
  const server = await createWorkbenchServer(options);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const { port } = server.address();
  return {
    address: 'http://127.0.0.1:' + port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    request(path, { method = 'GET', headers = {}, body, expected = 200 } = {}) {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const requestHeaders = data === undefined ? headers : {
        ...headers, 'content-type': 'application/json', 'content-length': data.length,
      };
      return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: requestHeaders }, async (res) => {
          try {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            const text = Buffer.concat(chunks).toString('utf8');
            assert.equal(res.statusCode, expected, method + ' ' + path);
            const result = res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text;
            resolve({ result, headers: res.headers });
          } catch (error) {
            reject(error);
          }
        });
        req.on('error', reject);
        req.setTimeout(10_000, () => req.destroy(new Error('HTTP request timed out: ' + path)));
        req.end(data);
      });
    },
  };
}

function hostedRequest(http, path, { credentials, headers, ...options } = {}) {
  return http.request(path, {
    ...options,
    headers: { ...safeHeaders, ...(credentials ? { authorization: credentials } : {}), ...headers },
  });
}

test('hosted mode requires login and preserves account isolation across restart', { timeout: 45_000 }, async (t) => {
  const directory = await temporaryWorkspace(t);
  const dataDir = join(directory, 'data');
  const accountFile = join(directory, 'test-accounts.json');
  await writeFile(accountFile, JSON.stringify({
    alice: account(firstPassword, '18'.repeat(16)),
    bob: account(secondPassword, '92'.repeat(16)),
  }), { flag: 'wx' });
  const env = { LAW_WEB_PUBLIC_ORIGIN: publicOrigin, LAW_WEB_ACCOUNTS_FILE: accountFile };
  const hosted = await loadHostedAccess(env);
  let http = await listen({ dataDir, hosted });
  try {
    for (const path of ['/', '/app.js', '/api/config', '/api/cases']) {
      const anonymous = await hostedRequest(http, path, { expected: 401 });
      assert.match(anonymous.headers['www-authenticate'], /^Basic\b/u);
      assert.equal(anonymous.headers['cache-control'], 'no-store');
    }
    for (const credentials of [basic('alice', secondPassword), basic('missing', firstPassword)]) {
      await hostedRequest(http, '/api/cases', { credentials, expected: 401 });
    }
    const html = await hostedRequest(http, '/', { credentials: alice });
    assert.match(html.result, /案卷工作台/u);
    assert.equal(html.headers['cache-control'], 'no-store');
    const clickedLink = {
      'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
    };
    await hostedRequest(http, '/', { headers: clickedLink, expected: 401 });
    assert.match((await hostedRequest(http, '/', { credentials: alice, headers: clickedLink })).result, /案卷工作台/u);
    await hostedRequest(http, '/api/cases', { credentials: alice, headers: clickedLink, expected: 403 });
    for (const headers of [
      { host: 'malicious.example.test' },
      { 'x-forwarded-proto': 'http' },
      { origin: 'http://' + domain },
      { origin: 'https://malicious.example.test' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      await hostedRequest(http, '/api/cases', { credentials: alice, headers, expected: 403 });
    }
    await http.request('/api/cases', { headers: { host: domain, authorization: alice }, expected: 403 });
    await hostedRequest(http, '/test-accounts.json', { credentials: alice, expected: 404 });

    const createCase = (credentials) => hostedRequest(http, '/api/cases', {
      credentials, method: 'POST', headers: { origin: publicOrigin },
      body: { title: '虚构同名案件' }, expected: 201,
    });
    const aliceCase = (await createCase(alice)).result;
    const bobCase = (await createCase(bob)).result;
    assert.notEqual(aliceCase.id, bobCase.id);
    const aliceCasePath = '/api/cases/' + aliceCase.id;
    const aliceNote = (await hostedRequest(http, aliceCasePath + '/materials', {
      credentials: alice, method: 'POST', headers: { origin: publicOrigin },
      body: { sourceLabel: '虚构接案笔录', text: '虚构的账户隔离测试材料' }, expected: 201,
    })).result;
    const aliceNotePath = aliceCasePath + '/materials/' + aliceNote.id;
    const note = await hostedRequest(http, aliceNotePath, { credentials: alice });
    assert.equal(note.result.text, '虚构的账户隔离测试材料');
    for (const path of [aliceCasePath, aliceNotePath, note.result.originalUrl, aliceCasePath + '/outputs']) {
      await hostedRequest(http, path, { credentials: bob, expected: 404 });
    }
    await hostedRequest(http, aliceCasePath, {
      credentials: bob, method: 'PATCH', headers: { origin: publicOrigin },
      body: { expectedRevision: aliceCase.revision, stage: '跨账号修改' }, expected: 404,
    });

    const ownCaseIds = async (credentials) =>
      (await hostedRequest(http, '/api/cases', { credentials })).result.cases.map(({ id }) => id);
    assert.deepEqual(await ownCaseIds(alice), [aliceCase.id]);
    assert.deepEqual(await ownCaseIds(bob), [bobCase.id]);

    await http.close();
    http = null;
    http = await listen({ dataDir, hosted: await loadHostedAccess(env) });
    assert.deepEqual(await ownCaseIds(alice), [aliceCase.id]);
    assert.deepEqual(await ownCaseIds(bob), [bobCase.id]);
    assert.equal((await hostedRequest(http, aliceNotePath, { credentials: alice })).result.text, note.result.text);

    await http.close();
    http = null;
    http = await listen({ dataDir });
    assert.match((await http.request('/')).result, /案卷工作台/u);
    assert.deepEqual((await http.request('/api/cases')).result.cases, []);
    await hostedRequest(http, '/api/cases', { credentials: alice, expected: 403 });
    const localCase = (await http.request('/api/cases', {
      method: 'POST', headers: { origin: http.address }, body: { title: '本地模式独立案件' }, expected: 201,
    })).result;
    assert.deepEqual((await http.request('/api/cases')).result.cases.map(({ id }) => id), [localCase.id]);
  } finally {
    await http?.close();
  }
});

test('incomplete or invalid hosted settings fail closed', async (t) => {
  const directory = await temporaryWorkspace(t);
  const file = join(directory, 'test-accounts.json');
  const env = { LAW_WEB_PUBLIC_ORIGIN: publicOrigin, LAW_WEB_ACCOUNTS_FILE: file };
  assert.ok(!(await loadHostedAccess({})));
  await assert.rejects(() => loadHostedAccess({ LAW_WEB_PUBLIC_ORIGIN: publicOrigin }));
  await assert.rejects(() => loadHostedAccess({ LAW_WEB_ACCOUNTS_FILE: file }));
  await assert.rejects(() => loadHostedAccess(env));
  const valid = account(firstPassword, '18'.repeat(16));
  await writeFile(file, JSON.stringify({ alice: valid }));
  for (const badOrigin of ['http://' + domain, publicOrigin + '/some-path', publicOrigin + '?a=b']) {
    await assert.rejects(() => loadHostedAccess({ ...env, LAW_WEB_PUBLIC_ORIGIN: badOrigin }));
  }
  for (const badFile of [
    '{ invalid json',
    '[]',
    '{}',
    JSON.stringify({ '../escape': valid }),
    JSON.stringify({ alice: { salt: valid.salt, hash: 'not-a-hash' } }),
  ]) {
    await writeFile(file, badFile);
    await assert.rejects(() => loadHostedAccess(env));
  }
});
