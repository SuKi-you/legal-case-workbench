import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CaseError, CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { CaseRollback } from '../src/cases/rollback.ts';
import type { RollbackPreview } from '../src/cases/contracts.ts';
import type { OcrAdapter } from '../src/materials/contracts.ts';

const image = fileURLToPath(new URL('../examples/fixtures/ocr-sample.png', import.meta.url));
function ocr(text: string): OcrAdapter {
  return { engine: { id: 'rollback-test-only', version: '1', languages: ['chi_sim'] },
    recognize: async () => ({ text, confidence: 75, lines: [] }), close: async () => {} };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-case-rollback-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const dataDir = join(directory, 'data');
  const cases = new CaseStore(dataDir);
  const workspace = new CaseWorkspace(dataDir, cases);
  const rollback = new CaseRollback(cases, workspace);
  const record = await cases.create({ title: '虚构案件原资料', caseNumber: 'A-001', description: '原描述', stage: '接案中', actor: '测试律师' });
  return { directory, dataDir, cases, workspace, rollback, caseId: record.id };
}
function applyInput(preview: RollbackPreview) {
  return { caseId: preview.caseId, checkpointId: preview.checkpointId, expectedRevision: preview.expectedRevision,
    previewToken: preview.token, actor: '测试律师', note: '验证恢复案件保存点' };
}

test('whole-case rollback restores profile, material/file membership, OCR and text versions; undo restores the pre-rollback view', async (t) => {
  const { directory, dataDir, cases, workspace, rollback, caseId } = await fixture(t);
  const text = await workspace.registerText({ caseId, sourceLabel: '原文字', text: '工资8000元。' });
  const photo = await workspace.registerImage({ caseId, sourceLabel: '原图', path: image });
  const firstOcr = await workspace.recognize({ caseId, materialId: photo.id }, ocr('原识别8000元。'));
  const original = (await workspace.listVersions({ caseId, materialId: text.id }))[0]!;
  const oldReference = await workspace.createReference({ caseId, materialId: text.id, versionId: original.id, start: 2, end: 7, quote: '8000元' });
  const originalFile = join(directory, 'original.pdf');
  await writeFile(originalFile, '%PDF-1.7\nOpaque fictional original');
  const file = await workspace.importFile({ caseId, path: originalFile, sourceLabel: '原附件' });
  const checkpoint = await rollback.createCheckpoint({ caseId, label: '第一次整理完成', actor: '测试律师' });
  const revision = await workspace.saveRevision({ caseId, materialId: text.id, baseVersionId: original.id,
    baseTextSha256: original.textSha256, text: '工资6000元。', editor: '测试律师' });
  const newReference = await workspace.createReference({ caseId, materialId: text.id, versionId: revision.id, start: 2, end: 7, quote: '6000元' });
  const secondOcr = await workspace.recognize({ caseId, materialId: photo.id }, ocr('后来识别9000元。'));
  const late = await workspace.registerText({ caseId, sourceLabel: '后加文字', text: '保存点之后的资料' });
  const latePath = join(directory, 'later.docx');
  await writeFile(latePath, Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff]));
  const lateFile = await workspace.importFile({ caseId, path: latePath, sourceLabel: '后加附件' });
  const lateFileView = await workspace.readFile({ caseId, fileId: lateFile.id });
  const lateMaterialView = await workspace.readMaterial({ caseId, materialId: late.id });
  const externalExport = join(directory, 'exports', 'later.docx');
  await workspace.exportFile({ caseId, fileId: lateFile.id, destination: externalExport });
  const current = await cases.read(caseId);
  await cases.update({ caseId, expectedRevision: current.revision, actor: '测试律师',
    title: '后来修改的标题', caseNumber: 'A-002', description: '后来描述', stage: '庭前准备', status: 'closed' });
  const preview = await rollback.preview({ caseId, checkpointId: checkpoint.id });
  assert.equal(preview.fields.length, 5);
  assert.deepEqual(preview.materialsLeaving, [late.id]);
  assert.deepEqual(preview.filesLeaving, [lateFile.id]);
  assert.ok(preview.versionsLeaving.some((entry) => entry.versionId === revision.id));
  assert.ok(preview.referencesLeaving.some((entry) => entry.referenceId === newReference.id));
  assert.deepEqual(preview.ocrAttemptsLeaving, [{ materialId: photo.id, attemptId: secondOcr.id }]);
  const result = await rollback.apply(applyInput(preview));
  assert.equal(result.case.title, '虚构案件原资料');
  assert.equal(result.case.stage, '接案中');
  assert.equal(result.case.status, 'active');
  assert.equal(result.case.revision, preview.expectedRevision + 1);
  assert.equal(result.case.createdAt, checkpoint.record.createdAt);
  assert.equal(result.undoCheckpoint.automatic, true);
  assert.equal(result.undoCheckpoint.sourceRevision, preview.expectedRevision);
  const restored = new CaseWorkspace(dataDir);
  const contents = await restored.contents(caseId);
  assert.deepEqual(new Set(contents.materials.map((entry) => entry.id)), new Set([text.id, photo.id]));
  assert.deepEqual(contents.files.map((entry) => entry.id), [file.id]);
  assert.deepEqual((await restored.listVersions({ caseId, materialId: text.id })).map((entry) => entry.id), [original.id]);
  assert.deepEqual((await restored.readMaterial({ caseId, materialId: photo.id })).ocrAttempts.map((entry) => entry.id), [firstOcr.id]);
  await assert.rejects(restored.readVersion({ caseId, materialId: text.id, versionId: revision.id }));
  await assert.rejects(restored.readMaterial({ caseId, materialId: late.id }));
  await assert.rejects(restored.readFile({ caseId, fileId: lateFile.id }));
  // Historical citations still prove what their original fixed version said.
  assert.equal((await restored.resolveReference({ caseId, materialId: text.id, referenceId: oldReference.id })).reference.quote, '8000元');
  assert.equal((await restored.resolveReference({ caseId, materialId: text.id, referenceId: newReference.id })).reference.quote, '6000元');
  assert.equal(await readFile(lateMaterialView.originalPath, 'utf8'), '保存点之后的资料');
  assert.deepEqual(await readFile(lateFileView.originalPath), await readFile(latePath));
  assert.deepEqual(await readFile(externalExport), await readFile(latePath));
  const restartedRollback = new CaseRollback(new CaseStore(dataDir), restored);
  assert.ok((await restartedRollback.listCheckpoints(caseId)).some((entry) => entry.id === result.undoCheckpoint.id));
  const undoPreview = await restartedRollback.preview({ caseId, checkpointId: result.undoCheckpoint.id });
  assert.deepEqual(undoPreview.materialsReturning, [late.id]);
  assert.deepEqual(undoPreview.filesReturning, [lateFile.id]);
  await restartedRollback.apply(applyInput(undoPreview));
  const undone = await restored.contents(caseId);
  assert.equal(undone.case.title, '后来修改的标题');
  assert.equal(undone.case.status, 'closed');
  assert.equal(undone.materials.length, 3);
  assert.equal(undone.files.length, 2);
  assert.equal((await restored.listVersions({ caseId, materialId: text.id })).length, 2);
  assert.equal((await restored.readMaterial({ caseId, materialId: photo.id })).ocrAttempts.length, 2);
});

test('a resource save after preview invalidates the rollback even when case profile fields are unchanged', async (t) => {
  const { cases, workspace, rollback, caseId } = await fixture(t);
  const checkpoint = await rollback.createCheckpoint({ caseId, label: '空案件', actor: '测试律师' });
  const preview = await rollback.preview({ caseId, checkpointId: checkpoint.id });
  const material = await workspace.registerText({ caseId, sourceLabel: '预览后保存', text: '不能被旧预览吞掉' });
  const revisionAfterSave = (await cases.read(caseId)).revision;
  assert.ok(revisionAfterSave > preview.expectedRevision);
  await assert.rejects(rollback.apply(applyInput(preview)), (error: unknown) => error instanceof CaseError && error.code === 'CASE_ROLLBACK_STALE');
  assert.equal((await workspace.contents(caseId)).materials[0]?.id, material.id);
  assert.equal((await rollback.listCheckpoints(caseId)).length, 1);
});

test('failed OCR attempts appear in rollback preview and successful restoration restores the prior OCR history', async (t) => {
  const { workspace, rollback, caseId } = await fixture(t);
  const photo = await workspace.registerImage({ caseId, sourceLabel: '测试图', path: image });
  const checkpoint = await rollback.createCheckpoint({ caseId, label: '识别前', actor: '测试律师' });
  const failed = await workspace.recognize({ caseId, materialId: photo.id }, ocr(''));
  assert.equal(failed.status, 'failed');
  const preview = await rollback.preview({ caseId, checkpointId: checkpoint.id });
  assert.deepEqual(preview.versionsLeaving, []);
  assert.deepEqual(preview.ocrAttemptsLeaving, [{ materialId: photo.id, attemptId: failed.id }]);
  await rollback.apply(applyInput(preview));
  assert.deepEqual((await workspace.readMaterial({ caseId, materialId: photo.id })).ocrAttempts, []);
});

test('tokens bind the selected checkpoint and current revision; same-label save points remain distinct', async (t) => {
  const { cases, workspace, rollback, caseId } = await fixture(t);
  const first = await rollback.createCheckpoint({ caseId, label: '相同名称', actor: '测试律师' });
  await workspace.registerText({ caseId, sourceLabel: '后来材料', text: '内容' });
  const second = await rollback.createCheckpoint({ caseId, label: '相同名称', actor: '测试律师' });
  assert.notEqual(first.id, second.id);
  const preview = await rollback.preview({ caseId, checkpointId: first.id });
  const other = await rollback.preview({ caseId, checkpointId: second.id });
  assert.notEqual(preview.token, other.token);
  await assert.rejects(rollback.apply({ ...applyInput(preview), checkpointId: second.id }), /CASE_ROLLBACK_STALE/);
  await assert.rejects(rollback.apply({ ...applyInput(preview), previewToken: '0'.repeat(64) }), /CASE_ROLLBACK_STALE/);
  const before = await cases.read(caseId);
  await cases.update({ caseId, expectedRevision: before.revision, actor: '测试律师', stage: '已更新进度' });
  await assert.rejects(rollback.apply(applyInput(preview)), /CASE_ROLLBACK_STALE/);
  assert.equal((await cases.read(caseId)).stage, '已更新进度');
});

test('a checkpoint from another case or a missing save point cannot be previewed or applied', async (t) => {
  const { cases, rollback, caseId } = await fixture(t);
  const checkpoint = await rollback.createCheckpoint({ caseId, label: 'A案', actor: '测试律师' });
  const other = await cases.create({ title: 'B案', actor: '测试律师' });
  await assert.rejects(rollback.preview({ caseId: other.id, checkpointId: checkpoint.id }), /CHECKPOINT_NOT_FOUND/);
  await assert.rejects(rollback.preview({ caseId, checkpointId: randomUUID() }), /CHECKPOINT_NOT_FOUND/);
  await assert.rejects(rollback.preview({ caseId: '../outside', checkpointId: checkpoint.id }));
  assert.equal((await cases.read(other.id)).revision, 1);
});

test('damaged target originals are rejected before restoration without adding rollback or undo history', async (t) => {
  const { directory, cases, workspace, rollback, caseId } = await fixture(t);
  const path = join(directory, 'file.docx');
  await writeFile(path, 'opaque original bytes');
  const stored = await workspace.importFile({ caseId, path, sourceLabel: '文件' });
  const checkpoint = await rollback.createCheckpoint({ caseId, label: '有效保存点', actor: '测试律师' });
  const view = await workspace.readFile({ caseId, fileId: stored.id });
  const revision = (await cases.read(caseId)).revision;
  await writeFile(view.originalPath, 'tampered');
  await assert.rejects(rollback.preview({ caseId, checkpointId: checkpoint.id }), /CASE_FILE_CHANGED/);
  assert.equal((await cases.read(caseId)).revision, revision);
  assert.equal((await rollback.listCheckpoints(caseId)).length, 1);
});

test('a resource save racing after preview validation is caught by the final journal CAS', async (t) => {
  const { cases, workspace, rollback, caseId } = await fixture(t);
  const checkpoint = await rollback.createCheckpoint({ caseId, label: '保存点', actor: '测试律师' });
  const preview = await rollback.preview({ caseId, checkpointId: checkpoint.id });
  const restore = cases.restoreCheckpoint.bind(cases);
  let inserted = false;
  cases.restoreCheckpoint = async (input) => {
    if (!inserted) {
      inserted = true;
      await workspace.registerText({ caseId, sourceLabel: '最后时刻保存', text: '应保留此内容' });
    }
    return restore(input);
  };
  await assert.rejects(rollback.apply(applyInput(preview)), /CASE_ROLLBACK_STALE/);
  assert.equal((await workspace.contents(caseId)).materials.length, 1);
  assert.equal((await cases.history(caseId)).filter((event) => event.kind === 'rolled_back').length, 0);
});

test('simultaneous applications of one preview publish only one rollback and one automatic undo point', async (t) => {
  const { dataDir, cases, workspace, rollback, caseId } = await fixture(t);
  const checkpoint = await rollback.createCheckpoint({ caseId, label: '之前', actor: '测试律师' });
  await workspace.registerText({ caseId, sourceLabel: '之后', text: '后加内容' });
  const preview = await rollback.preview({ caseId, checkpointId: checkpoint.id });
  const second = new CaseRollback(new CaseStore(dataDir), new CaseWorkspace(dataDir));
  const results = await Promise.allSettled([rollback.apply(applyInput(preview)), second.apply(applyInput(preview))]);
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(results.filter((entry) => entry.status === 'rejected').length, 1);
  assert.equal((await cases.history(caseId)).filter((event) => event.kind === 'rolled_back').length, 1);
  const points = await rollback.listCheckpoints(caseId);
  assert.equal(points.length, 2);
  assert.equal(points.filter((point) => point.automatic).length, 1);
});
