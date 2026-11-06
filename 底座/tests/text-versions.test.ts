import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type OcrAdapter } from '../src/materials/contracts.ts';
import { MaterialError, MaterialStore } from '../src/materials/store.ts';
import { MaterialTextStore } from '../src/materials/versions.ts';
import type { TextRevision, TextVersion } from '../src/materials/text-contracts.ts';
import { deferred } from './helpers.ts';

const source = { groupId: 'version-case', sourceLabel: '虚构材料' };
const image = fileURLToPath(new URL('../examples/fixtures/ocr-sample.png', import.meta.url));
const ocr = (text = '月薪8000元'): OcrAdapter => ({
  engine: { id: 'deterministic-test-only', version: '1', languages: ['chi_sim'] },
  recognize: async () => ({
    text, confidence: 80,
    lines: [{ text, confidence: 80, box: { x0: 10, y0: 20, x1: 160, y1: 45 } }],
  }),
  close: async () => {},
});
function edit(base: TextVersion, text: string) {
  return { materialId: base.materialId, baseVersionId: base.id, baseTextSha256: base.textSha256, text, editor: '测试核对人' };
}
function revisionPath(dataDir: string, revision: TextRevision): string {
  return join(dataDir, 'materials', revision.materialId, 'text-revisions', `${revision.id}.json`);
}
async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-text-versions-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const materials = new MaterialStore(dataDir);
  const texts = new MaterialTextStore(dataDir, materials);
  return { dataDir, materials, texts };
}
const code = (expected: string) => (error: unknown) => error instanceof MaterialError && error.code === expected;

test('old text originals need no migration; direct edits preserve exact originals and survive restart', async (t) => {
  const { dataDir, materials, texts } = await fixture(t);
  const original = '  原始陈述\r\n😀 月薪8000元。\n';
  const material = await materials.registerText({ ...source, text: original });
  const base = (await texts.listVersions(material.id))[0]!;
  assert.equal(base.id, material.id);
  assert.equal(base.kind, 'original');
  assert.equal(base.textSha256, material.sha256);
  await assert.rejects(access(join(dataDir, 'materials', material.id, 'text-revisions')));
  const changed = original.replace('8000', '6000');
  const revision = await texts.saveRevision({ ...edit(base, changed), note: '对照原件纠正数字' });
  assert.equal(revision.kind, 'revision');
  assert.equal(revision.review, 'user_edited');
  assert.equal(revision.baseVersionId, base.id);
  assert.equal(revision.note, '对照原件纠正数字');
  assert.notEqual(revision.id, base.id);
  assert.notEqual(revision.textSha256, base.textSha256);
  const restarted = new MaterialTextStore(dataDir);
  assert.deepEqual((await restarted.readVersion({ materialId: material.id, versionId: revision.id })).version, revision);
  assert.equal((await restarted.readVersion({ materialId: material.id, versionId: base.id })).version.text, original);
  const restored = await materials.read(material.id);
  assert.deepEqual(await readFile(restored.originalPath), Buffer.from(original, 'utf8'));
  assert.equal(restored.text, original);
});

test('OCR edits retain the image and source attempt; later OCR never overwrites or selects another version', async (t) => {
  const { dataDir, materials, texts } = await fixture(t);
  const material = await materials.registerImage({ ...source, path: image });
  const first = await materials.recognize(material.id, ocr());
  const attemptFile = join(dataDir, 'materials', material.id, 'ocr', `${first.id}.json`);
  const before = await readFile(attemptFile);
  const base = (await texts.readVersion({ materialId: material.id, versionId: first.id })).version;
  assert.equal(base.kind, 'ocr');
  if (base.kind !== 'ocr') assert.fail('Expected OCR version');
  assert.equal(base.review, 'unreviewed');
  assert.equal(base.lines.length, 1);
  const revision = await texts.saveRevision(edit(base, '月薪6000元'));
  assert.equal('lines' in revision, false);
  assert.equal('engine' in revision, false);
  const another = await materials.recognize(material.id, ocr('月薪9000元'));
  const restarted = new MaterialTextStore(dataDir);
  const versions = await restarted.listVersions(material.id);
  assert.equal(versions.length, 3);
  assert.equal(versions.find((version) => version.id === first.id)?.text, '月薪8000元');
  assert.equal(versions.find((version) => version.id === another.id)?.text, '月薪9000元');
  assert.equal(versions.find((version) => version.id === revision.id)?.text, '月薪6000元');
  assert.deepEqual(await readFile(attemptFile), before);
  assert.deepEqual(await readFile((await materials.read(material.id)).originalPath), await readFile(image));
});

test('simultaneous edits from one base preserve both branches and explicit descendant links', async (t) => {
  const { dataDir, materials, texts } = await fixture(t);
  const material = await materials.registerText({ ...source, text: '月薪8000元' });
  const base = (await texts.listVersions(material.id))[0]!;
  const [left, right] = await Promise.all([
    texts.saveRevision(edit(base, '月薪6000元')),
    new MaterialTextStore(dataDir).saveRevision(edit(base, '月薪7000元')),
  ]);
  assert.notEqual(left.id, right.id);
  assert.equal(left.baseVersionId, base.id);
  assert.equal(right.baseVersionId, base.id);
  const child = await texts.saveRevision(edit(left, '月薪6000元，另有奖金'));
  assert.equal(child.baseVersionId, left.id);
  const versions = await new MaterialTextStore(dataDir).listVersions(material.id);
  assert.deepEqual(new Set(versions.map((version) => version.id)), new Set([base.id, left.id, right.id, child.id]));
});

test('concurrent new OCR plus its revision cannot produce a revision with a missing parent snapshot', async (t) => {
  const { dataDir, materials, texts } = await fixture(t);
  const material = await materials.registerImage({ ...source, path: image });
  const captured = deferred();
  const resume = deferred();
  const pausedMaterials = new class extends MaterialStore {
    override async read(materialId: string) {
      const view = await super.read(materialId);
      captured.resolve();
      await resume.promise;
      return view;
    }
  }(dataDir);
  const reading = new MaterialTextStore(dataDir, pausedMaterials).listVersions(material.id);
  await captured.promise;
  try {
    const attempt = await materials.recognize(material.id, ocr());
    const base = (await texts.readVersion({ materialId: material.id, versionId: attempt.id })).version;
    await texts.saveRevision(edit(base, '月薪6000元'));
  } finally { resume.resolve(); }
  // The in-flight read represents its earlier revision/source snapshot, while
  // a fresh read observes both the OCR and its committed descendant.
  assert.deepEqual(await reading, []);
  assert.equal((await texts.listVersions(material.id)).length, 2);
});

test('revision saves reject unknown/cross-material bases and mismatched base checksums without creating a revision', async (t) => {
  const { materials, texts } = await fixture(t);
  const material = await materials.registerText({ ...source, text: '甲材料' });
  const second = await materials.registerText({ ...source, text: '乙材料' });
  const base = (await texts.listVersions(material.id))[0]!;
  await assert.rejects(texts.saveRevision({ ...edit(base, '新文字'), baseTextSha256: '0'.repeat(64) }), code('BASE_VERSION_CHANGED'));
  await assert.rejects(texts.saveRevision({ ...edit(base, '新文字'), baseVersionId: randomUUID() }), code('VERSION_NOT_FOUND'));
  await assert.rejects(texts.saveRevision({ ...edit(base, '新文字'), materialId: second.id }), code('VERSION_NOT_FOUND'));
  assert.equal((await texts.listVersions(material.id)).length, 1);
  assert.equal((await texts.listVersions(second.id)).length, 1);
});

test('an empty correction is preserved, while malformed UTF-16 input is rejected before saving', async (t) => {
  const { materials, texts } = await fixture(t);
  const material = await materials.registerText({ ...source, text: '删除错误识别文字' });
  const base = (await texts.listVersions(material.id))[0]!;
  const empty = await texts.saveRevision(edit(base, ''));
  assert.equal((await texts.readVersion({ materialId: material.id, versionId: empty.id })).version.text, '');
  for (const invalid of ['\ud83d', '\ude00', '前文\ud83d后文']) {
    await assert.rejects(texts.saveRevision(edit(base, invalid)), /isolated UTF-16 surrogate/);
  }
  assert.equal((await texts.listVersions(material.id)).length, 2);
});

test('failed OCR attempts are not readable text versions and cannot be a revision base', async (t) => {
  const { materials, texts } = await fixture(t);
  const material = await materials.registerImage({ ...source, path: image });
  assert.deepEqual(await texts.listVersions(material.id), []);
  const failed = await materials.recognize(material.id, ocr(''));
  assert.equal(failed.status, 'failed');
  assert.deepEqual(await texts.listVersions(material.id), []);
  await assert.rejects(texts.readVersion({ materialId: material.id, versionId: failed.id }), code('VERSION_NOT_FOUND'));
  await assert.rejects(texts.saveRevision({
    materialId: material.id, baseVersionId: failed.id, baseTextSha256: '0'.repeat(64), text: '猜测文字', editor: '核对人',
  }), code('VERSION_NOT_FOUND'));
});

test('saved revision integrity checks reject modified text and broken identity/base records', async (t) => {
  const cases = [
    { name: 'text checksum', change: (revision: TextRevision) => ({ ...revision, text: '被改写' }), expected: 'TEXT_VERSION_CHANGED' },
    { name: 'material identity', change: (revision: TextRevision) => ({ ...revision, materialId: randomUUID() }), expected: 'RECORD_INVALID' },
    { name: 'filename identity', change: (revision: TextRevision) => ({ ...revision, id: randomUUID() }), expected: 'RECORD_INVALID' },
    { name: 'missing base', change: (revision: TextRevision) => ({ ...revision, baseVersionId: randomUUID() }), expected: 'RECORD_INVALID' },
    { name: 'base checksum', change: (revision: TextRevision) => ({ ...revision, baseTextSha256: '0'.repeat(64) }), expected: 'RECORD_INVALID' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (child) => {
      const { dataDir, materials, texts } = await fixture(child);
      const material = await materials.registerText({ ...source, text: '原文' });
      const base = (await texts.listVersions(material.id))[0]!;
      const revision = await texts.saveRevision(edit(base, '修订'));
      await writeFile(revisionPath(dataDir, revision), JSON.stringify(scenario.change(revision)));
      const restarted = new MaterialTextStore(dataDir);
      await assert.rejects(restarted.listVersions(material.id), code(scenario.expected));
      await assert.rejects(restarted.readVersion({ materialId: material.id, versionId: revision.id }), code(scenario.expected));
    });
  }
});

test('cycles in revision ancestry are rejected even when each record has valid text and parent checksums', async (t) => {
  const { dataDir, materials, texts } = await fixture(t);
  const material = await materials.registerText({ ...source, text: '原文' });
  const base = (await texts.listVersions(material.id))[0]!;
  const left = await texts.saveRevision(edit(base, '左'));
  const right = await texts.saveRevision(edit(left, '右'));
  await writeFile(revisionPath(dataDir, left), JSON.stringify({ ...left, baseVersionId: right.id, baseTextSha256: right.textSha256 }));
  await assert.rejects(new MaterialTextStore(dataDir).listVersions(material.id), /ancestry contains a cycle/);
});

test('version reads reject path traversal and changed originals before returning text', async (t) => {
  const { materials, texts } = await fixture(t);
  await assert.rejects(texts.listVersions('../outside'));
  const material = await materials.registerText({ ...source, text: '原文' });
  const view = await materials.read(material.id);
  await writeFile(view.originalPath, 'changed');
  await assert.rejects(texts.readVersion({ materialId: material.id, versionId: material.id }), code('ORIGINAL_CHANGED'));
});
