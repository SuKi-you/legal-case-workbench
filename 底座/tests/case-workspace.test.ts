import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { MaterialStore } from '../src/materials/store.ts';
import type { OcrAdapter } from '../src/materials/contracts.ts';

const image = fileURLToPath(new URL('../examples/fixtures/ocr-sample.png', import.meta.url));
const fakeOcr: OcrAdapter = {
  engine: { id: 'case-test-only', version: '1', languages: ['chi_sim'] },
  recognize: async () => ({ text: '月薪8000元', confidence: 80, lines: [] }), close: async () => {},
};
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-case-workspace-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const dataDir = join(directory, 'data');
  const cases = new CaseStore(dataDir);
  const workspace = new CaseWorkspace(dataDir, cases);
  const first = await cases.create({ title: '同名案件', actor: '测试律师', stage: '材料整理' });
  const second = await cases.create({ title: '同名案件', actor: '测试律师', stage: '接案中' });
  return { directory, dataDir, cases, workspace, first, second };
}

test('workspace materials use independent case roots and forced case grouping across restart', async (t) => {
  const { dataDir, cases, workspace, first, second } = await fixture(t);
  const material = await workspace.registerText({ caseId: first.id, sourceLabel: '陈述', text: '第一案陈述' });
  assert.equal(material.groupId, first.id);
  const view = await workspace.readMaterial({ caseId: first.id, materialId: material.id });
  assert.ok(view.originalPath.startsWith(join(cases.directory(first.id), 'materials')));
  const restored = new CaseWorkspace(dataDir);
  assert.equal((await restored.contents(first.id)).materials[0]?.id, material.id);
  assert.equal((await restored.contents(second.id)).materials.length, 0);
  await assert.rejects(workspace.registerText({ caseId: first.id, sourceLabel: 'bad', text: 'x', groupId: second.id } as never));
  await assert.rejects(workspace.registerText({ caseId: randomUUID(), sourceLabel: 'bad', text: 'x' }), /CASE_NOT_FOUND/);
  await assert.rejects(workspace.contents('../outside'));
});

test('materials, versions, references and OCR cannot use another case IDs or fall back to global material storage', async (t) => {
  const { dataDir, workspace, first, second } = await fixture(t);
  const a = await workspace.registerText({ caseId: first.id, sourceLabel: 'A材料', text: '工资8000元' });
  const b = await workspace.registerText({ caseId: second.id, sourceLabel: 'B材料', text: '工资8000元' });
  const base = (await workspace.listVersions({ caseId: first.id, materialId: a.id }))[0]!;
  const revision = await workspace.saveRevision({
    caseId: first.id, materialId: a.id, baseVersionId: base.id, baseTextSha256: base.textSha256,
    text: '工资6000元', editor: '测试律师',
  });
  const reference = await workspace.createReference({
    caseId: first.id, materialId: a.id, versionId: revision.id, start: 2, end: 7, quote: '6000元',
  });
  await assert.rejects(workspace.readMaterial({ caseId: second.id, materialId: a.id }), /MATERIAL_NOT_FOUND/);
  await assert.rejects(workspace.listVersions({ caseId: second.id, materialId: a.id }), /MATERIAL_NOT_FOUND/);
  await assert.rejects(workspace.readVersion({ caseId: second.id, materialId: b.id, versionId: revision.id }), /CASE_VERSION_NOT_ACTIVE/);
  await assert.rejects(workspace.saveRevision({
    caseId: second.id, materialId: b.id, baseVersionId: revision.id, baseTextSha256: revision.textSha256,
    text: '不能改入B案', editor: '测试律师',
  }), /CASE_VERSION_NOT_ACTIVE/);
  await assert.rejects(workspace.createReference({
    caseId: second.id, materialId: b.id, versionId: revision.id, start: 2, end: 7, quote: '6000元',
  }), /CASE_VERSION_NOT_ACTIVE/);
  await assert.rejects(workspace.resolveReference({ caseId: second.id, materialId: b.id, referenceId: reference.id }), /REFERENCE_NOT_FOUND/);
  await assert.rejects(workspace.recognize({ caseId: second.id, materialId: a.id }, fakeOcr), /MATERIAL_NOT_FOUND/);
  const global = await new MaterialStore(dataDir).registerText({ groupId: first.id, sourceLabel: '旧全局材料', text: '不自动归入案件' });
  await assert.rejects(workspace.readMaterial({ caseId: first.id, materialId: global.id }), /MATERIAL_NOT_FOUND/);
  assert.equal((await workspace.contents(first.id)).materials.length, 1);
  assert.equal((await workspace.contents(second.id)).materials.length, 1);
  assert.equal((await new CaseWorkspace(dataDir).resolveReference({
    caseId: first.id, materialId: a.id, referenceId: reference.id,
  })).reference.quote, '6000元');
});

test('case image OCR and manual revisions reuse existing stores without overwriting their original', async (t) => {
  const { dataDir, workspace, first } = await fixture(t);
  const material = await workspace.registerImage({ caseId: first.id, sourceLabel: '虚构测试图', path: image });
  const recognized = await workspace.recognize({ caseId: first.id, materialId: material.id }, fakeOcr);
  assert.equal(recognized.status, 'success');
  const base = (await workspace.listVersions({ caseId: first.id, materialId: material.id }))[0]!;
  const revision = await workspace.saveRevision({
    caseId: first.id, materialId: material.id, baseVersionId: base.id, baseTextSha256: base.textSha256,
    text: '月薪6000元', editor: '测试律师',
  });
  const changed = await new CaseWorkspace(dataDir).readVersion({ caseId: first.id, materialId: material.id, versionId: revision.id });
  assert.deepEqual(await readFile(changed.originalPath), await readFile(image));
  assert.equal(changed.version.kind, 'revision');
  assert.equal('lines' in changed.version, false);
  const original = await workspace.readVersion({ caseId: first.id, materialId: material.id, versionId: recognized.id });
  assert.equal(original.version.text, '月薪8000元');
});

test('raw PDF and Word files preserve bytes and names, are isolated, and can be retrieved after restart and closure', async (t) => {
  const { directory, dataDir, cases, workspace, first, second } = await fixture(t);
  const samples = [
    { name: '证据.pdf', bytes: Buffer.from('%PDF-1.7\nraw fixture\u0000') },
    { name: '律师笔记.docx', bytes: Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff, 8, 5]) },
  ];
  for (const sample of samples) {
    const source = join(directory, sample.name);
    await writeFile(source, sample.bytes);
    const stored = await workspace.importFile({ caseId: first.id, path: source, sourceLabel: sample.name });
    await writeFile(source, '上传路径后来已改变');
    const restored = await new CaseWorkspace(dataDir).readFile({ caseId: first.id, fileId: stored.id });
    assert.equal(restored.file.fileName, sample.name);
    assert.deepEqual(await readFile(restored.originalPath), sample.bytes);
    await assert.rejects(workspace.readFile({ caseId: second.id, fileId: stored.id }), /CASE_FILE_NOT_FOUND/);
    const destination = join(directory, 'downloads', sample.name);
    await workspace.exportFile({ caseId: first.id, fileId: stored.id, destination });
    assert.deepEqual(await readFile(destination), sample.bytes);
    await assert.rejects(workspace.exportFile({ caseId: first.id, fileId: stored.id, destination }), /EEXIST/);
    assert.deepEqual(await readFile(destination), sample.bytes);
  }
  const beforeClosure = await cases.read(first.id);
  await cases.update({ caseId: first.id, expectedRevision: beforeClosure.revision, actor: '测试律师', status: 'closed', stage: '已结案' });
  const note = await workspace.registerText({ caseId: first.id, sourceLabel: '结案后补记', text: '仍可显式存取材料' });
  assert.equal((await new CaseWorkspace(dataDir).readMaterial({ caseId: first.id, materialId: note.id })).text, '仍可显式存取材料');
  assert.equal((await workspace.contents(first.id)).files.length, 2);
  assert.equal((await workspace.contents(second.id)).files.length, 0);
});

test('changed attachment bytes or wrong case identity are rejected without affecting a different case', async (t) => {
  const { directory, cases, workspace, first, second } = await fixture(t);
  const source = join(directory, 'file.pdf');
  await writeFile(source, '%PDF-original');
  const stored = await workspace.importFile({ caseId: first.id, path: source, sourceLabel: '原件' });
  const view = await workspace.readFile({ caseId: first.id, fileId: stored.id });
  await writeFile(view.originalPath, 'changed');
  await assert.rejects(workspace.readFile({ caseId: first.id, fileId: stored.id }), /CASE_FILE_CHANGED/);
  await assert.rejects(workspace.exportFile({ caseId: first.id, fileId: stored.id, destination: join(directory, 'bad-export') }), /CASE_FILE_CHANGED/);
  assert.equal((await workspace.contents(second.id)).files.length, 0);
  await writeFile(view.originalPath, '%PDF-original');
  await writeFile(join(cases.directory(first.id), 'files', stored.id, 'record.json'), JSON.stringify({ ...stored, caseId: second.id }));
  await assert.rejects(workspace.readFile({ caseId: first.id, fileId: stored.id }), /CASE_FILE_RECORD_INVALID/);
});

test('exports reject managed case/global folders and their junction aliases; material export preserves original bytes', async (t) => {
  const { directory, dataDir, cases, workspace, first, second } = await fixture(t);
  const material = await workspace.registerText({ caseId: first.id, sourceLabel: '陈述', text: '原始文字' });
  const destinations = [
    join(cases.directory(second.id), 'pollution.txt'), join(dataDir, 'materials', 'pollution.txt'),
  ];
  const alias = join(directory, 'looks-like-download');
  await symlink(join(dataDir, 'cases'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  destinations.push(join(alias, second.id, 'pollution.txt'));
  for (const destination of destinations) {
    await assert.rejects(workspace.exportMaterial({ caseId: first.id, materialId: material.id, destination }), /CASE_EXPORT_DESTINATION_INVALID/);
  }
  const destination = join(directory, 'exports', '原始文字.txt');
  await workspace.exportMaterial({ caseId: first.id, materialId: material.id, destination });
  assert.deepEqual(await readFile(destination), Buffer.from('原始文字', 'utf8'));
  await assert.rejects(workspace.exportMaterial({ caseId: second.id, materialId: material.id, destination: `${destination}.other` }), /MATERIAL_NOT_FOUND/);
});

test('incomplete imports are not listed, committed corrupt records fail explicitly, and raw file size is bounded', async (t) => {
  const { directory, cases, workspace, first } = await fixture(t);
  const pending = join(cases.directory(first.id), 'files', randomUUID());
  await mkdir(pending, { recursive: true });
  await writeFile(join(pending, 'original.bin'), 'not committed');
  assert.equal((await workspace.contents(first.id)).files.length, 0);
  const source = join(directory, 'oversize.bin');
  const handle = await import('node:fs/promises').then((fs) => fs.open(source, 'w'));
  try { await handle.truncate(50 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(workspace.importFile({ caseId: first.id, path: source, sourceLabel: '过大文件' }), /CASE_FILE_INVALID/);
  // A filesystem metadata file alone is no longer a committed workspace item:
  // corrupt a record actually published by the case API, preserving this check.
  const committedSource = join(directory, 'committed.pdf');
  await writeFile(committedSource, '%PDF-fictional committed original');
  const committed = await workspace.importFile({ caseId: first.id, path: committedSource, sourceLabel: '已提交附件' });
  await writeFile(join(cases.directory(first.id), 'files', committed.id, 'record.json'), '{broken');
  await assert.rejects(workspace.contents(first.id), /CASE_FILE_RECORD_INVALID/);
});
