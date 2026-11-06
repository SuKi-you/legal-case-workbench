import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SourceReferenceStore } from '../src/materials/references.ts';
import { MaterialStore } from '../src/materials/store.ts';
import { MaterialTextStore } from '../src/materials/versions.ts';
import type { CreateReferenceInput } from '../src/materials/text-contracts.ts';
import type { OcrAdapter } from '../src/materials/contracts.ts';

const source = { groupId: 'reference-tests', sourceLabel: '虚构材料' };
const image = fileURLToPath(new URL('../examples/fixtures/ocr-sample.png', import.meta.url));
async function setup(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-references-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const materials = new MaterialStore(dataDir);
  const texts = new MaterialTextStore(dataDir, materials);
  return { dataDir, materials, texts, references: new SourceReferenceStore(dataDir, texts) };
}
function fakeOcr(text: string): OcrAdapter {
  return {
    engine: { id: 'reference-test-only', version: '1', languages: ['chi_sim'] },
    recognize: async () => ({
      text, confidence: 60,
      lines: [{ text, confidence: 60, box: { x0: 10, y0: 10, x1: 100, y1: 40 } }],
    }),
    close: async () => {},
  };
}

test('references remain bound to their original version after correction and restart', async (t) => {
  const { dataDir, materials, texts, references } = await setup(t);
  const material = await materials.registerText({ ...source, text: '月薪8000元。' });
  const original = (await texts.readVersion({ materialId: material.id, versionId: material.id })).version;
  const oldReference = await references.create({ materialId: material.id, versionId: original.id, start: 2, end: 7, quote: '8000元' });
  const revision = await texts.saveRevision({
    materialId: material.id, baseVersionId: original.id, baseTextSha256: original.textSha256,
    text: '月薪6000元。', editor: '承办人',
  });
  const newReference = await references.create({ materialId: material.id, versionId: revision.id, start: 2, end: 7, quote: '6000元' });
  const restarted = new SourceReferenceStore(dataDir);
  const oldResult = await restarted.resolve({ materialId: material.id, referenceId: oldReference.id });
  const newResult = await restarted.resolve({ materialId: material.id, referenceId: newReference.id });
  assert.equal(oldResult.version.id, original.id);
  assert.equal(oldResult.version.text, '月薪8000元。');
  assert.equal(oldResult.reference.quote, '8000元');
  assert.equal(newResult.version.id, revision.id);
  assert.equal(newResult.version.text, '月薪6000元。');
  assert.equal(newResult.reference.quote, '6000元');
  assert.equal(newResult.version.review, 'user_edited');
  assert.equal(newResult.material.sourceLabel, source.sourceLabel);
  assert.equal(await readFile(oldResult.originalPath, 'utf8'), '月薪8000元。');
});

test('OCR and edited references preserve original image provenance without inheriting stale boxes', async (t) => {
  const { materials, texts, references } = await setup(t);
  const material = await materials.registerImage({ ...source, path: image });
  const attempt = await materials.recognize(material.id, fakeOcr('月薪8000元。'));
  assert.equal(attempt.status, 'success');
  const recognized = (await texts.readVersion({ materialId: material.id, versionId: attempt.id })).version;
  const old = await references.create({ materialId: material.id, versionId: attempt.id, start: 2, end: 7, quote: '8000元' });
  const revision = await texts.saveRevision({
    materialId: material.id, baseVersionId: recognized.id, baseTextSha256: recognized.textSha256,
    text: '月薪6000元。', editor: '承办人',
  });
  const revised = await references.create({ materialId: material.id, versionId: revision.id, start: 2, end: 7, quote: '6000元' });
  const originalResult = await references.resolve({ materialId: material.id, referenceId: old.id });
  const revisedResult = await references.resolve({ materialId: material.id, referenceId: revised.id });
  assert.equal(originalResult.version.kind, 'ocr');
  assert.ok('lines' in originalResult.version);
  assert.equal(revisedResult.version.kind, 'revision');
  assert.equal('lines' in revisedResult.version, false);
  assert.equal(revisedResult.originalPath, originalResult.originalPath);
  assert.deepEqual(await readFile(revisedResult.originalPath), await readFile(image));
});

test('duplicate excerpts retain the explicitly selected occurrence and UTF-16 offsets', async (t) => {
  const { materials, references } = await setup(t);
  const text = '😀6000元；6000元。';
  const material = await materials.registerText({ ...source, text });
  const quote = '6000元';
  const first = text.indexOf(quote);
  const second = text.lastIndexOf(quote);
  const records = await Promise.all([first, second].map((start) => references.create({
    materialId: material.id, versionId: material.id, start, end: start + quote.length, quote,
  })));
  assert.notEqual(records[0]!.start, records[1]!.start);
  for (const record of records) {
    const restored = await references.resolve({ materialId: material.id, referenceId: record.id });
    assert.equal(restored.reference.start, record.start);
    assert.equal(text.slice(restored.reference.start, restored.reference.end), quote);
  }
});

test('out-of-bounds, empty or reversed ranges and mismatched excerpts are rejected', async (t) => {
  const { materials, references } = await setup(t);
  const material = await materials.registerText({ ...source, text: '工资6000元' });
  const request: CreateReferenceInput = { materialId: material.id, versionId: material.id, start: 2, end: 7, quote: '6000元' };
  for (const invalid of [
    { start: -1 }, { start: 2.5 }, { start: 7, end: 7 }, { start: 8, end: 7 },
    { end: 100 }, { end: Number.MAX_SAFE_INTEGER + 1 }, { quote: '' }, { quote: '8000元' },
  ]) {
    await assert.rejects(references.create({ ...request, ...invalid }));
  }
});

test('reference boundaries cannot split an emoji surrogate pair', async (t) => {
  const { materials, references } = await setup(t);
  const material = await materials.registerText({ ...source, text: '😀6000元😀' });
  const base = { materialId: material.id, versionId: material.id };
  const whole = await references.create({ ...base, start: 0, end: 2, quote: '😀' });
  assert.equal((await references.resolve({ materialId: material.id, referenceId: whole.id })).reference.quote, '😀');
  await assert.rejects(references.create({ ...base, start: 1, end: 2, quote: 'x' }), /REFERENCE_RANGE_INVALID/);
  await assert.rejects(references.create({ ...base, start: 0, end: 1, quote: 'x' }), /REFERENCE_RANGE_INVALID/);
  await assert.rejects(references.create({ ...base, start: 0, end: 1, quote: '\ud83d' }));
});

test('wrong version, cross-material version, failed OCR and invalid path identities cannot become references', async (t) => {
  const { materials, references } = await setup(t);
  const one = await materials.registerText({ ...source, text: '6000元' });
  const two = await materials.registerText({ ...source, text: '6000元' });
  const request = { materialId: one.id, versionId: one.id, start: 0, end: 5, quote: '6000元' };
  await assert.rejects(references.create({ ...request, versionId: randomUUID() }));
  await assert.rejects(references.create({ ...request, versionId: two.id }));
  await assert.rejects(references.create({ ...request, materialId: '../outside' }));
  await assert.rejects(references.resolve({ materialId: one.id, referenceId: '../outside' }));
  const picture = await materials.registerImage({ ...source, path: image });
  const failed = await materials.recognize(picture.id, fakeOcr(''));
  assert.equal(failed.status, 'failed');
  await assert.rejects(references.create({ ...request, materialId: picture.id, versionId: failed.id }));
});

test('saved reference identity, hash, range and quote are rechecked on every resolve', async (t) => {
  const { dataDir, materials, references } = await setup(t);
  const material = await materials.registerText({ ...source, text: '月薪6000元。' });
  const reference = await references.create({ materialId: material.id, versionId: material.id, start: 2, end: 7, quote: '6000元' });
  const path = join(dataDir, 'materials', material.id, 'references', `${reference.id}.json`);
  const request = { materialId: material.id, referenceId: reference.id };
  for (const invalid of [
    { id: randomUUID() }, { materialId: randomUUID() }, { versionId: randomUUID() },
    { textSha256: '0'.repeat(64) }, { start: 0 }, { end: 100 }, { quote: '8000元' },
  ]) {
    await writeFile(path, JSON.stringify({ ...reference, ...invalid }));
    await assert.rejects(references.resolve(request));
  }
  await writeFile(path, '{broken json');
  await assert.rejects(references.resolve(request), /REFERENCE_INVALID/);
  await writeFile(path, JSON.stringify(reference));
  assert.equal((await references.resolve(request)).reference.id, reference.id);
  await assert.rejects(references.resolve({ materialId: material.id, referenceId: randomUUID() }), /REFERENCE_NOT_FOUND/);
});

test('a saved OCR excerpt rejects later changes to its fixed version text', async (t) => {
  const { dataDir, materials, references } = await setup(t);
  const material = await materials.registerImage({ ...source, path: image });
  const attempt = await materials.recognize(material.id, fakeOcr('月薪6000元。'));
  assert.equal(attempt.status, 'success');
  const reference = await references.create({ materialId: material.id, versionId: attempt.id, start: 2, end: 7, quote: '6000元' });
  const path = join(dataDir, 'materials', material.id, 'ocr', `${attempt.id}.json`);
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.output.text = '月薪7000元。';
  await writeFile(path, JSON.stringify(record));
  await assert.rejects(references.resolve({ materialId: material.id, referenceId: reference.id }), /REFERENCE_VERSION_CHANGED/);
});

test('reference resolution also checks that the saved original has not changed', async (t) => {
  const { materials, references } = await setup(t);
  const material = await materials.registerText({ ...source, text: '6000元' });
  const reference = await references.create({ materialId: material.id, versionId: material.id, start: 0, end: 5, quote: '6000元' });
  const view = await references.resolve({ materialId: material.id, referenceId: reference.id });
  await writeFile(view.originalPath, '8000元');
  await assert.rejects(references.resolve({ materialId: material.id, referenceId: reference.id }), /ORIGINAL_CHANGED/);
});
