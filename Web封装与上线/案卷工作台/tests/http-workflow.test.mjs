import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createWorkbenchServer } from '../server/index.mjs';

import { fixtureImage, fixtureModel, fixtureOcr, paymentReceipt, wageStatement } from './fixtures.mjs';

async function temporaryData(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-web-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}

async function localServer(options) {
  const server = await createWorkbenchServer(options);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = `http://127.0.0.1:${server.address().port}`;
  return {
    async request(path, { method = 'GET', body, origin = address, expected = 200 } = {}) {
      const response = await fetch(address + path, {
        method,
        headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const isJson = response.headers.get('content-type')?.includes('application/json');
      const result = isJson ? JSON.parse(bytes.toString('utf8')) : bytes;
      assert.equal(response.status, expected, `${method} ${path} → ${JSON.stringify(isJson ? result : { bytes: bytes.length })}`);
      return { result, headers: response.headers };
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const get = async (http, path) => (await http.request(path)).result;
const post = async (http, path, body, expected = 201) => (await http.request(path, { method: 'POST', body, expected })).result;

test('Web stores original materials, corrects OCR, runs labor reviews, downloads and restores case snapshots', { timeout: 180_000 }, async (t) => {
  const dataDir = await temporaryData(t);
  const model = fixtureModel();
  const ocr = await fixtureOcr(dataDir);
  let http = await localServer({ dataDir, model, ocr });
  try {
    assert.equal((await get(http, '/api/config')).modelConfigured, true);
    assert.match((await get(http, '/')).toString('utf8'), /案卷工作台/u);
    for (const path of ['/app.js', '/paper-link.js', '/styles.css']) await get(http, path);
    const crossOrigin = await http.request('/api/cases', {
      method: 'POST', origin: 'https://external.invalid', body: { title: '应拒绝的请求' }, expected: 403,
    });
    assert.equal(crossOrigin.result.error.code, 'CROSS_ORIGIN');
    await http.request('/.env.local', { expected: 404 });
    const main = await post(http, '/api/cases', { title: '虚构工资争议 · Web 验收', caseNumber: 'WEB-0001' });
    const other = await post(http, '/api/cases', { title: '独立虚构案卷' });
    const mainPath = '/api/cases/' + main.id;
    const otherPath = '/api/cases/' + other.id;
    assert.notEqual(main.id, other.id);
    const note = await post(http, mainPath + '/materials', { sourceLabel: '工资约定', text: wageStatement });
    assert.equal((await get(http, mainPath + '/materials/' + note.id)).text, wageStatement);
    assert.deepEqual((await get(http, otherPath)).materials, []);
    await http.request(otherPath + '/materials/' + note.id, { expected: 404 });

    const png = await readFile(fixtureImage);
    const image = await post(http, mainPath + '/materials', {
      sourceLabel: '工资清册图', fileName: '工资清册.png', base64: png.toString('base64'),
    });
    const imagePath = mainPath + '/materials/' + image.id;
    const attempt = await post(http, imagePath + '/ocr', {});
    assert.equal(attempt.status, 'success', JSON.stringify(attempt.error));
    assert.equal(attempt.engine.id, 'tesseract.js');
    assert.match(attempt.output.text, /6000/u);
    assert.ok(attempt.output.lines.length);
    const beforeEdit = await get(http, imagePath);
    const base = beforeEdit.versions.find(({ kind }) => kind === 'ocr');
    assert.ok(base);
    const edited = '模拟材料：九月工资6000元。';
    const revised = await post(http, imagePath + '/revisions', {
      baseVersionId: base.id, baseTextSha256: base.textSha256, text: edited, note: '校对原图，移除演示标签',
    });
    const afterEdit = await get(http, imagePath);
    assert.ok(afterEdit.versions.some((entry) => entry.id === base.id && entry.text === attempt.output.text));
    assert.ok(afterEdit.versions.some((entry) => entry.id === revised.id && entry.text === edited));
    const original = await http.request(afterEdit.originalUrl);
    assert.deepEqual(original.result, png);
    assert.equal(original.headers.get('content-type'), 'image/png');

    const intake = await post(http, mainPath + '/runs', { goal: '核对工资约定与到账情况' });
    assert.ok(model.calls > 0);
    assert.ok(intake.findings.some(({ citations }) => citations.some((item) => item.quote === wageStatement)));
    assert.ok(intake.sources.some((source) => source.materialId === image.id && source.versionId === revised.id));
    const firstDraft = await post(http, mainPath + '/outputs', { runId: intake.id });
    const checkpoint = await post(http, mainPath + '/checkpoints', { label: '接案底稿已保存' });

    const receipt = await post(http, mainPath + '/materials', { sourceLabel: '虚构银行回单', text: paymentReceipt });
    const secondRun = await post(http, mainPath + '/runs', { goal: '加入合成回单后复核工资' });
    const review = await post(http, mainPath + '/node-reviews', {
      baselineRunId: intake.id, currentRunId: secondRun.id, kind: 'new_evidence',
    }, 200);
    assert.equal(review.kind, 'new_evidence');
    assert.ok(review.sources.some((source) => source.kind === 'added' && source.materialId === receipt.id));
    const currentDraft = await post(http, mainPath + '/outputs', {
      runId: secondRun.id, previousOutputId: firstDraft.outputId, nodeReviewKind: 'new_evidence', baselineRunId: intake.id,
    });
    const details = await get(http, mainPath + '/outputs/' + currentDraft.outputId);
    assert.equal(details.draft.nodeReview?.kind, 'new_evidence');
    assert.ok(details.draft.references.some(({ citation }) => citation.quote === paymentReceipt));
    const word = await http.request(mainPath + '/outputs/' + currentDraft.outputId + '/docx');
    assert.equal(word.result.readUInt32LE(0), 0x04034b50);
    assert.match(word.headers.get('content-disposition'), /^attachment/u);
    const md = await get(http, mainPath + '/outputs/' + currentDraft.outputId + '/md');
    assert.match(md.toString('utf8'), /乔乙/u);
    await http.request(otherPath + '/outputs/' + currentDraft.outputId + '/docx', { expected: 404 });
    const current = (await get(http, mainPath)).case;
    const changed = await http.request(mainPath, { method: 'PATCH', body: {
      expectedRevision: current.revision, status: 'paused', stage: '等待补料',
    } });
    assert.equal(changed.result.stage, '等待补料');
    assert.equal(changed.result.status, 'paused');
    await http.request(mainPath, { method: 'PATCH', body: {
      expectedRevision: current.revision, stage: '过期进度修改',
    }, expected: 409 });

    const preview = await post(http, mainPath + '/rollback/preview', { checkpointId: checkpoint.id }, 200);
    assert.ok(preview.materialsLeaving.includes(receipt.id));
    assert.ok(preview.outputsLeaving.includes(currentDraft.outputId));
    const restored = await post(http, mainPath + '/rollback', {
      checkpointId: checkpoint.id, expectedRevision: preview.expectedRevision, previewToken: preview.token,
    }, 200);
    assert.equal(restored.case.status, 'active');
    assert.ok(restored.undoCheckpoint.id);
    assert.equal((await get(http, mainPath)).materials.length, 2);
    assert.deepEqual((await get(http, mainPath + '/outputs')).outputs.map(({ outputId }) => outputId), [firstDraft.outputId]);
    assert.deepEqual((await get(http, otherPath)).materials, []);
    await http.request(mainPath + '/outputs/' + currentDraft.outputId + '/docx', { expected: 404 });

    // Reopen from the same directory through a fresh server, not in-memory state.
    await http.close();
    http = null;
    http = await localServer({ dataDir, model });
    assert.equal((await get(http, mainPath)).case.title, main.title);
    assert.ok((await get(http, imagePath)).versions.some(({ id }) => id === revised.id));
    assert.equal((await get(http, '/api/cases')).cases.length, 2);
  } finally {
    await http?.close();
    await ocr.close();
  }
});
