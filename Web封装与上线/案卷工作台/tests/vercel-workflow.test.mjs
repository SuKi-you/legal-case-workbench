import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { createVercelHandler } from '../vercel/api/workbench.mjs';
import { fixtureModel, wageStatement } from './fixtures.mjs';

const host = 'workbench.example.test';
const password = 'synthetic-cloud-workflow-password';
const authorization = 'Basic ' + Buffer.from('alice:' + password).toString('base64');
const prefix = 'test-vercel-workflow';
const workspacePath = prefix + '/alice.gz';
const salt = '31'.repeat(16);
const env = {
  VERCEL_PROJECT_PRODUCTION_URL: host,
  LAW_WEB_ACCOUNTS_JSON: JSON.stringify({ alice: {
    salt, hash: scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex'),
  } }),
  BLOB_STORE_ID: 'store_mock',
  LAW_WEB_BLOB_PREFIX: prefix,
};

function mockStorage() {
  class BlobPreconditionFailedError extends Error {
    name = 'BlobPreconditionFailedError';
  }
  const records = new Map();
  let version = 0;
  return {
    records,
    BlobPreconditionFailedError,
    rejectNextWorkspaceWrite: false,
    async get(path, options) {
      assert.equal(options.token, undefined);
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      const stored = records.get(path);
      if (!stored) return null;
      return {
        statusCode: 200,
        blob: { etag: stored.etag, size: stored.bytes.length },
        stream: new Response(stored.bytes).body,
      };
    },
    async put(path, bytes, options) {
      assert.equal(options.token, undefined);
      assert.equal(options.access, 'private');
      assert.equal(options.addRandomSuffix, false);
      const previous = records.get(path);
      if (previous && (!options.allowOverwrite || options.ifMatch !== previous.etag)) throw new BlobPreconditionFailedError();
      if (path === workspacePath && this.rejectNextWorkspaceWrite) {
        this.rejectNextWorkspaceWrite = false;
        throw new Error('synthetic unavailable storage');
      }
      const etag = '"' + ++version + '"';
      records.set(path, { etag, bytes: Buffer.from(bytes) });
      return { etag };
    },
    async del(path, options) {
      assert.equal(options.token, undefined);
      if (records.get(path)?.etag !== options.ifMatch) throw new BlobPreconditionFailedError();
      records.delete(path);
    },
  };
}

async function startCloudApp(blob) {
  const model = fixtureModel();
  const handler = await createVercelHandler({ env, blob, model, ocr: { async close() {} } });
  const server = createServer((req, res) => handler.handle(req, res));
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const { port } = server.address();

  function request(path, { method = 'GET', body, expected = 200 } = {}) {
    const binary = Buffer.isBuffer(body);
    const bytes = body === undefined ? undefined : binary ? body : Buffer.from(JSON.stringify(body));
    const headers = { host, 'x-forwarded-proto': 'https', authorization };
    if (bytes) {
      headers.origin = 'https://' + host;
      headers['content-type'] = binary ? 'application/octet-stream' : 'application/json';
      headers['content-length'] = bytes.length;
    }
    // Exercise the same rewrite input used when the Vercel function is invoked.
    const url = '/api/workbench?__workbench_path=' + encodeURIComponent(path);
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: url, method, headers }, async (res) => {
        try {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          const data = Buffer.concat(chunks);
          const json = res.headers['content-type']?.includes('application/json');
          const result = json ? JSON.parse(data.toString('utf8')) : data;
          assert.equal(res.statusCode, expected, method + ' ' + path + ' ' + (json ? JSON.stringify(result.error ?? {}) : ''));
          resolve({ result, headers: res.headers });
        } catch (error) {
          reject(error);
        }
      });
      req.setTimeout(20_000, () => req.destroy(new Error('HTTP request timed out: ' + path)));
      req.on('error', reject);
      req.end(bytes);
    });
  }
  return {
    model, request,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      .finally(() => handler.close()),
  };
}

test('cloud HTTP workflow survives restart and streams, rolls back, and refuses failed durable writes', { timeout: 60_000 }, async () => {
  const blob = mockStorage();
  let app = await startCloudApp(blob);
  const get = async (path) => (await app.request(path)).result;
  const post = async (path, body, expected = 201) => (await app.request(path, { method: 'POST', body, expected })).result;
  try {
    assert.match((await get('/')).toString('utf8'), /案卷工作台/u);
    const config = await get('/api/config');
    assert.equal(config.modelConfigured, true);
    assert.equal(config.uploadPartBytes, 3 * 1024 * 1024);
    const item = await post('/api/cases', { title: '云端虚构工资争议' });
    const casePath = '/api/cases/' + item.id;
    const material = await post(casePath + '/materials', { sourceLabel: '虚构工资笔录', text: wageStatement });
    const sources = await get(casePath + '/sources');
    const selections = sources.materials.map(({ materialId, versions }) => ({ materialId, versionId: versions[0].id }));
    const intake = await post(casePath + '/runs', { goal: '核对虚构工资', consent: true, selections });
    assert.ok(app.model.calls > 0);
    assert.ok(intake.findings.some(({ citations }) => citations.some(({ quote }) => quote === wageStatement)));
    const draft = await post(casePath + '/outputs', { runId: intake.id });
    const checkpoint = await post(casePath + '/checkpoints', { label: '保存虚构工资底稿' });
    const before = await get(casePath);
    const beforeWrite = blob.records.get(workspacePath).etag;
    blob.rejectNextWorkspaceWrite = true;
    const failure = await app.request(casePath, { method: 'PATCH', expected: 503, body: {
      expectedRevision: before.case.revision, stage: '模拟写失败',
    } });
    assert.equal(failure.result.error.code, 'WORKSPACE_STORAGE_UNAVAILABLE');
    assert.equal(blob.records.get(workspacePath).etag, beforeWrite);
    assert.deepEqual((await get(casePath)).case, before.case);

    const upload = casePath + '/upload-parts/' + randomUUID();
    const original = Buffer.alloc(5 * 1024 * 1024, 0x40);
    original.write('%PDF-1.7\n');
    original.write('\n%%EOF\n', original.length - 7);
    const partCount = Math.ceil(original.length / config.uploadPartBytes);
    for (let i = 0; i < partCount; i++) {
      const part = original.subarray(i * config.uploadPartBytes, (i + 1) * config.uploadPartBytes);
      assert.deepEqual(await post(upload + '/' + i, part, 200), { partIndex: i });
    }
    const file = await post(upload, {
      sourceLabel: '虚构大型原件', fileName: 'fixture.pdf', byteLength: original.length, partCount,
    });
    const originalPath = casePath + '/files/' + file.id + '/original';
    await app.close();
    app = null;
    app = await startCloudApp(blob);

    assert.deepEqual((await get('/api/cases')).cases.map(({ id }) => id), [item.id]);
    assert.equal((await get(casePath + '/materials/' + material.id)).text, wageStatement);
    assert.equal((await get(casePath + '/outputs')).outputs[0].outputId, draft.outputId);
    const document = await app.request(casePath + '/outputs/' + draft.outputId + '/docx');
    assert.equal(document.result.readUInt32LE(0), 0x04034b50);
    const download = await app.request(originalPath);
    assert.equal(download.headers['content-type'], 'application/pdf');
    assert.equal(download.headers['content-length'], undefined);
    assert.equal(download.headers['transfer-encoding'], 'chunked');
    assert.deepEqual(download.result, original);

    const afterUploadEtag = blob.records.get(workspacePath).etag;
    const preview = await post(casePath + '/rollback/preview', { checkpointId: checkpoint.id }, 200);
    assert.equal(blob.records.get(workspacePath).etag, afterUploadEtag);
    assert.deepEqual(preview.filesLeaving, [file.id]);
    const restored = await post(casePath + '/rollback', {
      checkpointId: checkpoint.id, expectedRevision: preview.expectedRevision, previewToken: preview.token,
    }, 200);
    assert.ok(restored.undoCheckpoint.id);
    await app.close();
    app = null;
    app = await startCloudApp(blob);
    assert.deepEqual((await get(casePath)).files, []);
    await app.request(originalPath, { expected: 404 });
    assert.equal((await get(casePath + '/outputs')).outputs[0].outputId, draft.outputId);
    const undo = await post(casePath + '/rollback/preview', { checkpointId: restored.undoCheckpoint.id }, 200);
    assert.deepEqual(undo.filesReturning, [file.id]);
    await post(casePath + '/rollback', {
      checkpointId: undo.checkpointId, expectedRevision: undo.expectedRevision, previewToken: undo.token,
    }, 200);
    assert.deepEqual(await get(originalPath), original);
  } finally {
    await app?.close();
  }
});
