import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createRuntime, defineCapability, MATERIAL_CAPABILITIES, MaterialStore,
  materialRequestSchema, materialSchema, materialViewSchema, ocrAttemptSchema,
  type OcrAdapter, type OcrOutput, type PluginDefinition,
} from '../src/index.ts';

const image = fileURLToPath(new URL('../examples/fixtures/ocr-sample.png', import.meta.url));
const source = { groupId: 'sample-001', sourceLabel: '虚构测试材料' };
const output: OcrOutput = {
  text: '测试识别结果', confidence: 70,
  lines: [{ text: '测试识别结果', confidence: 70, box: { x0: 1, y0: 2, x1: 30, y1: 20 } }],
};
function fakeOcr(recognize: OcrAdapter['recognize'] = async () => output): OcrAdapter {
  return { engine: { id: 'test-only', version: '1', languages: ['chi_sim'] }, recognize, close: async () => {} };
}
async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-materials-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('standalone text registration preserves exact original, source and restart state', async (t) => {
  const dataDir = await temporary(t);
  const store = new MaterialStore(dataDir);
  const text = '  原始陈述\r\n😀 第二行。\n';
  const material = await store.registerText({ ...source, text });
  const restored = await new MaterialStore(dataDir).read(material.id);
  assert.equal(restored.text, text);
  assert.equal(restored.material.sourceLabel, source.sourceLabel);
  assert.equal(restored.material.groupId, source.groupId);
  assert.deepEqual(restored.ocrAttempts, []);
  assert.deepEqual(await readFile(restored.originalPath), Buffer.from(text));
});

test('image registration copies bytes and does not rely on the original upload path or extension', async (t) => {
  const dataDir = await temporary(t);
  const upload = join(dataDir, 'upload.dat');
  const bytes = await readFile(image);
  await writeFile(upload, bytes);
  const store = new MaterialStore(dataDir);
  const material = await store.registerImage({ ...source, path: upload });
  await writeFile(upload, 'caller replaced the upload');
  const view = await store.read(material.id);
  assert.equal(material.original.mediaType, 'image/png');
  assert.equal(view.text, undefined);
  assert.deepEqual(await readFile(view.originalPath), bytes);
});

test('OCR failure, blank output and retries append separate unreviewed records, readable after restart', async (t) => {
  const dataDir = await temporary(t);
  const store = new MaterialStore(dataDir);
  const material = await store.registerImage({ ...source, path: image });
  const failed = await store.recognize(material.id, fakeOcr(async () => { throw new Error('test engine failed'); }));
  const blank = await store.recognize(material.id, fakeOcr(async () => ({ ...output, text: '\n ' })));
  const success = await store.recognize(material.id, fakeOcr(async (bytes) => {
    assert.deepEqual(bytes, await readFile(image));
    return output;
  }));
  assert.equal(failed.status, 'failed');
  assert.equal(blank.status, 'failed');
  if (blank.status === 'failed') assert.equal(blank.error.code, 'NO_TEXT');
  assert.equal(success.status, 'success');
  const restored = await new MaterialStore(dataDir).read(material.id);
  assert.equal(restored.ocrAttempts.length, 3);
  assert.equal(new Set(restored.ocrAttempts.map((attempt) => attempt.id)).size, 3);
  assert.ok(restored.ocrAttempts.every((attempt) => attempt.review === 'unreviewed' && attempt.materialId === material.id));
  assert.deepEqual(restored.ocrAttempts.find((attempt) => attempt.id === success.id), success);
});

test('simultaneous OCR attempts keep both results rather than overwrite shared metadata', async (t) => {
  const store = new MaterialStore(await temporary(t));
  const material = await store.registerImage({ ...source, path: image });
  const results = await Promise.all([store.recognize(material.id, fakeOcr()), store.recognize(material.id, fakeOcr())]);
  const restored = await store.read(material.id);
  assert.deepEqual(new Set(restored.ocrAttempts.map((attempt) => attempt.id)), new Set(results.map((attempt) => attempt.id)));
});

test('changed saved originals are detected before reading or recognizing', async (t) => {
  const store = new MaterialStore(await temporary(t));
  const material = await store.registerImage({ ...source, path: image });
  const view = await store.read(material.id);
  await writeFile(view.originalPath, 'tampered');
  let called = false;
  await assert.rejects(store.read(material.id), /ORIGINAL_CHANGED/);
  await assert.rejects(store.recognize(material.id, fakeOcr(async () => { called = true; return output; })), /ORIGINAL_CHANGED/);
  assert.equal(called, false);
});

test('unsupported input and invalid identity are rejected; plain text is not sent to OCR', async (t) => {
  const dataDir = await temporary(t);
  const store = new MaterialStore(dataDir);
  const pdf = join(dataDir, 'fake.png');
  await writeFile(pdf, '%PDF-1.7');
  await assert.rejects(store.registerImage({ ...source, path: pdf }), /IMAGE_UNSUPPORTED/);
  await assert.rejects(store.read('../outside'));
  await assert.rejects(store.read('a53ee3d1-64d5-41d9-a540-2b5dfe98cdb1'), /MATERIAL_NOT_FOUND/);
  const material = await store.registerText({ ...source, text: '原文' });
  await assert.rejects(store.recognize(material.id, fakeOcr()), /NOT_AN_IMAGE/);
});

test('unified runtime provides common abilities to a consumer that only declares the public contract', async (t) => {
  const dataDir = await temporary(t);
  let closed = 0;
  const adapter = fakeOcr();
  adapter.close = async () => { closed += 1; };
  const consumerRef = { id: 'test.read-material', version: 1 };
  const consumer: PluginDefinition = {
    manifest: { id: 'test.consumer', version: '1', apiVersion: 1, requires: [MATERIAL_CAPABILITIES.read] },
    capabilities: [defineCapability({
      ...consumerRef, input: materialRequestSchema, output: materialViewSchema,
      execute: async (input, context) => {
        const result = await context.invoke(MATERIAL_CAPABILITIES.read, input);
        if (result.status !== 'success') throw new Error('Consumer could not read material');
        return { status: 'success', data: materialViewSchema.parse(result.data) };
      },
    })],
  };
  const host = await createRuntime({ dataDir, ocr: adapter, plugins: [consumer] });
  try {
    const registered = await host.invoke(MATERIAL_CAPABILITIES.registerImage, { ...source, path: image });
    if (registered.status !== 'success') assert.fail(JSON.stringify(registered));
    const material = materialSchema.parse(registered.data);
    const recognized = await host.invoke(MATERIAL_CAPABILITIES.recognize, { materialId: material.id });
    if (recognized.status !== 'success') assert.fail(JSON.stringify(recognized));
    assert.equal(ocrAttemptSchema.parse(recognized.data).status, 'success');
    const read = await host.invoke(consumerRef, { materialId: material.id });
    if (read.status !== 'success') assert.fail(JSON.stringify(read));
    assert.equal(materialViewSchema.parse(read.data).ocrAttempts.length, 1);
    const invalid = await host.invoke(MATERIAL_CAPABILITIES.read, { materialId: '../outside' });
    assert.equal(invalid.status, 'error');
    if (invalid.status === 'error') assert.equal(invalid.error.code, 'INPUT_INVALID');
  } finally {
    await host.stop();
    await host.stop();
  }
  assert.equal(closed, 1);
  const restarted = await createRuntime({ dataDir, ocr: fakeOcr() });
  try {
    assert.deepEqual(
      new Set(restarted.listCapabilities().filter((capability) => capability.id.startsWith('materials.')).map((capability) => capability.id)),
      new Set(Object.values(MATERIAL_CAPABILITIES).map((capability) => capability.id)),
    );
  } finally { await restarted.stop(); }
});

test('default runtime can start and stop without starting an OCR worker or downloading a model', async (t) => {
  const host = await createRuntime({ dataDir: await temporary(t) });
  assert.equal(host.state, 'ready');
  assert.deepEqual(await host.stop(), { status: 'stopped', cleanupErrors: [] });
});
