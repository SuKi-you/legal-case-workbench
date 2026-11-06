import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { CaseRollback } from '../src/cases/rollback.ts';
import { MaterialStore } from '../src/materials/store.ts';
import { MaterialTextStore } from '../src/materials/versions.ts';
import { SourceReferenceStore } from '../src/materials/references.ts';
import type { OcrAdapter } from '../src/materials/contracts.ts';

function signal() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-case-race-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const dataDir = join(directory, 'data');
  const cases = new CaseStore(dataDir);
  const workspace = new CaseWorkspace(dataDir, cases);
  const rollback = new CaseRollback(cases, workspace);
  const record = await cases.create({ title: '虚构并发案件', actor: '测试用户' });
  return { dataDir, cases, workspace, rollback, caseId: record.id };
}

test('simultaneous resource additions rebase without losing either saved material', { timeout: 10000 }, async (t) => {
  const { dataDir, cases, workspace, caseId } = await fixture(t);
  const bothReady = signal();
  const commit = cases.commitWorkspace.bind(cases);
  let arrivals = 0;
  cases.commitWorkspace = async (input) => {
    arrivals += 1;
    if (arrivals <= 2) {
      if (arrivals === 2) bothReady.release();
      await bothReady.promise;
    }
    return commit(input);
  };
  const otherWindow = new CaseWorkspace(dataDir, cases);
  const saved = await Promise.all([
    workspace.registerText({ caseId, sourceLabel: '窗口甲', text: '甲保存的材料' }),
    otherWindow.registerText({ caseId, sourceLabel: '窗口乙', text: '乙保存的材料' }),
  ]);
  assert.deepEqual(new Set((await workspace.contents(caseId)).materials.map((item) => item.id)), new Set(saved.map((item) => item.id)));
  assert.equal((await cases.read(caseId)).revision, 3);
  assert.deepEqual((await cases.history(caseId)).map((event) => event.kind), ['created', 'workspace_updated', 'workspace_updated']);
});

test('an OCR operation started before rollback cannot republish its late result into the restored case', { timeout: 10000 }, async (t) => {
  const { dataDir, cases, workspace, rollback, caseId } = await fixture(t);
  const photo = await workspace.registerImage({ caseId, sourceLabel: '模拟照片',
    path: fileURLToPath(new URL('../examples/fixtures/ocr-sample.png', import.meta.url)) });
  const checkpoint = await rollback.createCheckpoint({ caseId, label: '识别之前', actor: '测试用户' });
  await workspace.registerText({ caseId, sourceLabel: '后来补充', text: '本次回滚应隐藏这条材料' });
  const entered = signal();
  const finish = signal();
  const adapter: OcrAdapter = {
    engine: { id: 'controlled-test-only', version: '1', languages: ['chi_sim'] },
    recognize: async () => { entered.release(); await finish.promise; return { text: '迟到的识别结果', confidence: 80, lines: [] }; },
    close: async () => {},
  };
  const pending = workspace.recognize({ caseId, materialId: photo.id }, adapter);
  // Attach the rejection observer before resuming the worker.
  const rejected = assert.rejects(pending, /CASE_WORKSPACE_CHANGED/);
  try {
    await entered.promise;
    const preview = await rollback.preview({ caseId, checkpointId: checkpoint.id });
    const result = await rollback.apply({ caseId, checkpointId: checkpoint.id,
      expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '测试用户' });
    finish.release();
    await rejected;
    assert.equal((await workspace.contents(caseId)).materials.length, 1);
    assert.deepEqual((await workspace.readMaterial({ caseId, materialId: photo.id })).ocrAttempts, []);
    assert.deepEqual(await workspace.listVersions({ caseId, materialId: photo.id }), []);
    // Original/staged records are retained, but never advertised as a successful case save.
    assert.equal((await new MaterialStore(cases.directory(caseId)).read(photo.id)).ocrAttempts.length, 1);
    const restarted = new CaseRollback(new CaseStore(dataDir), new CaseWorkspace(dataDir));
    const undoPreview = await restarted.preview({ caseId, checkpointId: result.undoCheckpoint.id });
    await restarted.apply({ caseId, checkpointId: result.undoCheckpoint.id,
      expectedRevision: undoPreview.expectedRevision, previewToken: undoPreview.token, actor: '测试用户' });
    assert.equal((await workspace.contents(caseId)).materials.length, 2);
    assert.deepEqual((await workspace.readMaterial({ caseId, materialId: photo.id })).ocrAttempts, []);
    assert.equal((await cases.history(caseId)).filter((event) => event.kind === 'rolled_back').length, 2);
  } finally { finish.release(); await rejected; }
});

test('legacy workspace initialization captures existing originals, revisions and references only once', async (t) => {
  const { dataDir, cases, workspace, rollback, caseId } = await fixture(t);
  const creation = join(cases.directory(caseId), 'revisions', '0000000000000001.json');
  const legacy = JSON.parse(await readFile(creation, 'utf8'));
  delete legacy.workspace;
  await writeFile(creation, JSON.stringify(legacy));
  const materials = new MaterialStore(cases.directory(caseId));
  const texts = new MaterialTextStore(cases.directory(caseId), materials);
  const references = new SourceReferenceStore(cases.directory(caseId), texts);
  const material = await materials.registerText({ groupId: caseId, sourceLabel: '旧案文字', text: '原记载8000元' });
  const base = (await texts.listVersions(material.id))[0]!;
  const revision = await texts.saveRevision({ materialId: material.id, baseVersionId: base.id,
    baseTextSha256: base.textSha256, text: '核对后6000元', editor: '旧案用户' });
  const reference = await references.create({ materialId: material.id, versionId: revision.id, start: 3, end: 8, quote: '6000元' });
  const state = await workspace.snapshotState(caseId);
  assert.equal(state.record.revision, 2);
  assert.deepEqual(state.workspace.materials[0]?.referenceIds, [reference.id]);
  assert.deepEqual(new Set(state.workspace.materials[0]?.versions.map((item) => item.versionId)), new Set([base.id, revision.id]));
  const checkpoint = await rollback.createCheckpoint({ caseId, label: '旧案首次完整保存点', actor: '测试用户' });
  assert.equal(checkpoint.sourceRevision, 2);
  assert.deepEqual((await new CaseWorkspace(dataDir).snapshotState(caseId)).workspace, checkpoint.workspace);
  assert.equal((await cases.history(caseId)).filter((event) => event.kind === 'workspace_initialized').length, 1);
});
