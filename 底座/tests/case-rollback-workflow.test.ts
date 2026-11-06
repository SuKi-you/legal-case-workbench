import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CASE_CAPABILITIES, caseCheckpointSchema, caseContentsSchema, caseFileViewSchema,
  caseRecordSchema, createRuntime, materialSchema, materialViewSchema, ocrAttemptSchema,
  resolvedReferenceSchema, rollbackPreviewSchema, rollbackResultSchema, sourceReferenceSchema,
  storedCaseFileSchema, textVersionSchema, textVersionsSchema, textVersionViewSchema,
  type CapabilityRef, type CaseRecord, type OcrAdapter, type PluginHost,
} from '../src/index.ts';

const image = fileURLToPath(new URL('../examples/fixtures/ocr-sample.png', import.meta.url));

function fakeOcr(): OcrAdapter {
  let calls = 0;
  return {
    engine: { id: 'test-only-rollback-ocr', version: '1', languages: ['chi_sim'] },
    recognize: async () => {
      const text = calls++ === 0 ? '虚构识别工资8000元。' : '虚构识别工资9000元。';
      return { text, confidence: 80,
        lines: [{ text, confidence: 80, box: { x0: 1, y0: 2, x1: 180, y1: 30 } }] };
    },
    close: async () => {},
  };
}

async function directoryFor(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-rollback-workflow-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), 'law-agent-rollback-workflow-')));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function invoke(host: PluginHost, ref: CapabilityRef, input: unknown): Promise<unknown> {
  const result = await host.invoke(ref, input);
  if (result.status !== 'success') assert.fail(JSON.stringify(result));
  return result.data;
}

async function executionError(host: PluginHost, ref: CapabilityRef, input: unknown): Promise<string> {
  const result = await host.invoke(ref, input);
  if (result.status !== 'error') assert.fail(`Expected execution error: ${JSON.stringify(result)}`);
  assert.equal(result.error.code, 'EXECUTION_FAILED');
  assert.ok(result.error.message.length > 0);
  return result.error.message;
}

async function currentCase(host: PluginHost, caseId: string): Promise<CaseRecord> {
  return caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.read, { caseId }));
}

function profile(record: CaseRecord) {
  const { revision: _revision, updatedAt: _updatedAt, ...fields } = record;
  return fields;
}

async function checkpointList(host: PluginHost, caseId: string) {
  const values = await invoke(host, CASE_CAPABILITIES.listCheckpoints, { caseId });
  assert.ok(Array.isArray(values));
  return values.map((value) => caseCheckpointSchema.parse(value));
}

test('full-case rollback restores its saved logical view, preserves historical references, and can be undone after restart', async (t) => {
  const dataDir = await directoryFor(t);
  const earlyFile = join(dataDir, 'early.pdf');
  const lateFile = join(dataDir, 'late.docx');
  const earlyBytes = Buffer.from('%PDF-1.7\nfictional raw attachment, not parsed\n');
  const lateBytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 9, 255, 18]);
  await writeFile(earlyFile, earlyBytes);
  await writeFile(lateFile, lateBytes);
  let host = await createRuntime({ dataDir, ocr: fakeOcr() });
  try {
    assert.equal(host.listCapabilities().length, 32);
    const a = caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.create, {
      title: '虚构甲案', caseNumber: 'ROLLBACK-A', description: '保存点之前的说明', actor: '测试律师',
    }));
    const b = caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.create, {
      title: '虚构乙案', actor: '测试律师',
    }));
    await invoke(host, CASE_CAPABILITIES.registerText, {
      caseId: b.id, sourceLabel: '乙案独立材料', text: '乙案内容不应受甲案回滚影响。',
    });
    const otherBefore = caseContentsSchema.parse(await invoke(host, CASE_CAPABILITIES.contents, { caseId: b.id }));
    const material = materialSchema.parse(await invoke(host, CASE_CAPABILITIES.registerImage, {
      caseId: a.id, sourceLabel: '甲案模拟图片', path: image,
    }));
    const firstAttempt = ocrAttemptSchema.parse(await invoke(host, CASE_CAPABILITIES.recognize, {
      caseId: a.id, materialId: material.id,
    }));
    assert.equal(firstAttempt.status, 'success');
    const base = textVersionViewSchema.parse(await invoke(host, CASE_CAPABILITIES.readVersion, {
      caseId: a.id, materialId: material.id, versionId: firstAttempt.id,
    })).version;
    const oldQuote = '8000元';
    const oldStart = base.text.indexOf(oldQuote);
    const oldReference = sourceReferenceSchema.parse(await invoke(host, CASE_CAPABILITIES.createReference, {
      caseId: a.id, materialId: material.id, versionId: base.id,
      start: oldStart, end: oldStart + oldQuote.length, quote: oldQuote,
    }));
    const initialFile = storedCaseFileSchema.parse(await invoke(host, CASE_CAPABILITIES.importFile, {
      caseId: a.id, path: earlyFile, sourceLabel: '保存点前的原始附件',
    }));
    const beforeMark = await currentCase(host, a.id);
    await invoke(host, CASE_CAPABILITIES.update, {
      caseId: a.id, expectedRevision: beforeMark.revision, stage: '材料整理中', status: 'paused', actor: '测试律师',
    });
    const target = caseCheckpointSchema.parse(await invoke(host, CASE_CAPABILITIES.createCheckpoint, {
      caseId: a.id, label: '补料前保存点', actor: '测试律师',
    }));
    assert.equal(target.automatic, false);

    const addedMaterial = materialSchema.parse(await invoke(host, CASE_CAPABILITIES.registerText, {
      caseId: a.id, sourceLabel: '保存点后补充材料', text: '后来补充的5000元记载。',
    }));
    const laterMaterialView = materialViewSchema.parse(await invoke(host, CASE_CAPABILITIES.readMaterial, {
      caseId: a.id, materialId: addedMaterial.id,
    }));
    const addedReference = sourceReferenceSchema.parse(await invoke(host, CASE_CAPABILITIES.createReference, {
      caseId: a.id, materialId: addedMaterial.id, versionId: addedMaterial.id,
      start: laterMaterialView.text!.indexOf('5000元'),
      end: laterMaterialView.text!.indexOf('5000元') + '5000元'.length, quote: '5000元',
    }));
    const secondAttempt = ocrAttemptSchema.parse(await invoke(host, CASE_CAPABILITIES.recognize, {
      caseId: a.id, materialId: material.id,
    }));
    assert.equal(secondAttempt.status, 'success');
    const revision = textVersionSchema.parse(await invoke(host, CASE_CAPABILITIES.saveRevision, {
      caseId: a.id, materialId: material.id, baseVersionId: base.id, baseTextSha256: base.textSha256,
      text: '虚构识别工资6000元。', editor: '测试律师',
    }));
    const revisedQuote = '6000元';
    const revisedStart = revision.text.indexOf(revisedQuote);
    const revisedReference = sourceReferenceSchema.parse(await invoke(host, CASE_CAPABILITIES.createReference, {
      caseId: a.id, materialId: material.id, versionId: revision.id,
      start: revisedStart, end: revisedStart + revisedQuote.length, quote: revisedQuote,
    }));
    const addedFile = storedCaseFileSchema.parse(await invoke(host, CASE_CAPABILITIES.importFile, {
      caseId: a.id, path: lateFile, sourceLabel: '保存点后补充的原始附件',
    }));
    const lateFileView = caseFileViewSchema.parse(await invoke(host, CASE_CAPABILITIES.readFile, {
      caseId: a.id, fileId: addedFile.id,
    }));
    const beforeChange = await currentCase(host, a.id);
    await invoke(host, CASE_CAPABILITIES.update, {
      caseId: a.id, expectedRevision: beforeChange.revision, title: '后来修改的甲案名称',
      caseNumber: 'ROLLBACK-A-NEW', description: '保存点之后的说明', stage: '庭前准备', status: 'closed', actor: '测试律师',
    });
    const beforeRollback = caseContentsSchema.parse(await invoke(host, CASE_CAPABILITIES.contents, { caseId: a.id }));
    const versionsBefore = textVersionsSchema.parse(await invoke(host, CASE_CAPABILITIES.listVersions, {
      caseId: a.id, materialId: material.id,
    }));
    const preview = rollbackPreviewSchema.parse(await invoke(host, CASE_CAPABILITIES.previewRollback, {
      caseId: a.id, checkpointId: target.id,
    }));
    assert.deepEqual(preview.materialsLeaving, [addedMaterial.id]);
    assert.deepEqual(preview.filesLeaving, [addedFile.id]);
    assert.ok(preview.versionsLeaving.some((entry) => entry.versionId === revision.id));
    assert.ok(preview.versionsLeaving.some((entry) => entry.versionId === secondAttempt.id));
    assert.ok(preview.referencesLeaving.some((entry) => entry.referenceId === revisedReference.id));
    assert.ok(preview.fields.some((field) => field.field === 'stage' && field.before === '庭前准备' && field.after === '材料整理中'));
    const restored = rollbackResultSchema.parse(await invoke(host, CASE_CAPABILITIES.applyRollback, {
      caseId: a.id, checkpointId: target.id, expectedRevision: preview.expectedRevision,
      previewToken: preview.token, actor: '测试律师', note: '回到补料前状态。',
    }));
    assert.equal(restored.restoredCheckpoint.id, target.id);
    assert.equal(restored.undoCheckpoint.automatic, true);
    assert.ok(restored.case.revision > preview.expectedRevision);
    assert.deepEqual(profile(restored.case), profile(target.record));

    await host.stop();
    host = await createRuntime({ dataDir, ocr: fakeOcr() });
    const afterRollback = caseContentsSchema.parse(await invoke(host, CASE_CAPABILITIES.contents, { caseId: a.id }));
    assert.deepEqual(profile(afterRollback.case), profile(target.record));
    assert.deepEqual(afterRollback.materials.map((entry) => entry.id), [material.id]);
    assert.deepEqual(afterRollback.files.map((entry) => entry.id), [initialFile.id]);
    const currentVersions = textVersionsSchema.parse(await invoke(host, CASE_CAPABILITIES.listVersions, {
      caseId: a.id, materialId: material.id,
    }));
    assert.deepEqual(currentVersions.map((entry) => entry.id), [base.id]);
    const currentMaterial = materialViewSchema.parse(await invoke(host, CASE_CAPABILITIES.readMaterial, {
      caseId: a.id, materialId: material.id,
    }));
    assert.deepEqual(currentMaterial.ocrAttempts.map((entry) => entry.id), [firstAttempt.id]);
    await executionError(host, CASE_CAPABILITIES.readVersion, { caseId: a.id, materialId: material.id, versionId: revision.id });
    // Rollback changes the current view; historical evidence remains physically
    // present and can still be traced by an already saved fixed-version reference.
    assert.equal(await readFile(laterMaterialView.originalPath, 'utf8'), laterMaterialView.text);
    assert.deepEqual(await readFile(lateFileView.originalPath), lateBytes);
    for (const [materialId, referenceId, expectedVersionId, quote] of [
      [material.id, oldReference.id, base.id, '8000元'],
      [material.id, revisedReference.id, revision.id, '6000元'],
      [addedMaterial.id, addedReference.id, addedMaterial.id, '5000元'],
    ] as const) {
      const resolved = resolvedReferenceSchema.parse(await invoke(host, CASE_CAPABILITIES.resolveReference, {
        caseId: a.id, materialId, referenceId,
      }));
      assert.equal(resolved.version.id, expectedVersionId);
      assert.equal(resolved.reference.quote, quote);
    }
    assert.deepEqual(caseContentsSchema.parse(await invoke(host, CASE_CAPABILITIES.contents, { caseId: b.id })), otherBefore);
    const checkpoints = await checkpointList(host, a.id);
    assert.ok(checkpoints.some((entry) => entry.id === target.id));
    assert.ok(checkpoints.some((entry) => entry.id === restored.undoCheckpoint.id));
    const undoPreview = rollbackPreviewSchema.parse(await invoke(host, CASE_CAPABILITIES.previewRollback, {
      caseId: a.id, checkpointId: restored.undoCheckpoint.id,
    }));
    const undone = rollbackResultSchema.parse(await invoke(host, CASE_CAPABILITIES.applyRollback, {
      caseId: a.id, checkpointId: restored.undoCheckpoint.id, expectedRevision: undoPreview.expectedRevision,
      previewToken: undoPreview.token, actor: '测试律师',
    }));
    const afterUndo = caseContentsSchema.parse(await invoke(host, CASE_CAPABILITIES.contents, { caseId: a.id }));
    assert.deepEqual(profile(afterUndo.case), profile(beforeRollback.case));
    assert.deepEqual(afterUndo.materials, beforeRollback.materials);
    assert.deepEqual(afterUndo.files, beforeRollback.files);
    assert.ok(undone.case.revision > restored.case.revision);
    assert.deepEqual(textVersionsSchema.parse(await invoke(host, CASE_CAPABILITIES.listVersions, {
      caseId: a.id, materialId: material.id,
    })).map((entry) => entry.id).sort(), versionsBefore.map((entry) => entry.id).sort());
  } finally { await host.stop(); }
});

test('a material saved after preview invalidates rollback without hiding the new saved content', async (t) => {
  const dataDir = await directoryFor(t);
  const host = await createRuntime({ dataDir, ocr: fakeOcr() });
  try {
    const record = caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.create, { title: '过期预览测试', actor: '用户' }));
    const target = caseCheckpointSchema.parse(await invoke(host, CASE_CAPABILITIES.createCheckpoint, {
      caseId: record.id, label: '空资料保存点', actor: '用户',
    }));
    const preview = rollbackPreviewSchema.parse(await invoke(host, CASE_CAPABILITIES.previewRollback, {
      caseId: record.id, checkpointId: target.id,
    }));
    const added = materialSchema.parse(await invoke(host, CASE_CAPABILITIES.registerText, {
      caseId: record.id, sourceLabel: '预览后刚保存的材料', text: '不能被过期预览静默隐藏。',
    }));
    const latest = await currentCase(host, record.id);
    assert.ok(latest.revision > preview.expectedRevision);
    const checkpointIds = (await checkpointList(host, record.id)).map((entry) => entry.id);
    assert.match(await executionError(host, CASE_CAPABILITIES.applyRollback, {
      caseId: record.id, checkpointId: target.id, expectedRevision: preview.expectedRevision,
      previewToken: preview.token, actor: '用户',
    }), /CONFLICT|STALE|CHANGED/i);
    assert.deepEqual(await currentCase(host, record.id), latest);
    const contents = caseContentsSchema.parse(await invoke(host, CASE_CAPABILITIES.contents, { caseId: record.id }));
    assert.deepEqual(contents.materials.map((entry) => entry.id), [added.id]);
    assert.deepEqual((await checkpointList(host, record.id)).map((entry) => entry.id), checkpointIds);
  } finally { await host.stop(); }
});

test('another case checkpoint cannot be previewed or applied to the selected case', async (t) => {
  const dataDir = await directoryFor(t);
  const host = await createRuntime({ dataDir, ocr: fakeOcr() });
  try {
    const a = caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.create, { title: '保存点甲案', actor: '用户' }));
    const b = caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.create, { title: '目标乙案', actor: '用户' }));
    const checkpoint = caseCheckpointSchema.parse(await invoke(host, CASE_CAPABILITIES.createCheckpoint, {
      caseId: a.id, label: '只属于甲案', actor: '用户',
    }));
    await executionError(host, CASE_CAPABILITIES.previewRollback, { caseId: b.id, checkpointId: checkpoint.id });
    await executionError(host, CASE_CAPABILITIES.applyRollback, {
      caseId: b.id, checkpointId: checkpoint.id, expectedRevision: b.revision,
      previewToken: 'a'.repeat(64), actor: '用户',
    });
    assert.deepEqual(await currentCase(host, b.id), b);
    assert.deepEqual(await checkpointList(host, b.id), []);
  } finally { await host.stop(); }
});

test('a changed preview token cannot authorize a different rollback or append an undo point', async (t) => {
  const dataDir = await directoryFor(t);
  const host = await createRuntime({ dataDir, ocr: fakeOcr() });
  try {
    const record = caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.create, { title: '预览校验', actor: '用户' }));
    const checkpoint = caseCheckpointSchema.parse(await invoke(host, CASE_CAPABILITIES.createCheckpoint, {
      caseId: record.id, label: '待核对保存点', actor: '用户',
    }));
    const current = await currentCase(host, record.id);
    await invoke(host, CASE_CAPABILITIES.update, {
      caseId: record.id, expectedRevision: current.revision, stage: '后来阶段', actor: '用户',
    });
    const preview = rollbackPreviewSchema.parse(await invoke(host, CASE_CAPABILITIES.previewRollback, {
      caseId: record.id, checkpointId: checkpoint.id,
    }));
    const before = await currentCase(host, record.id);
    const checkpoints = await checkpointList(host, record.id);
    const changedToken = `${preview.token[0] === '0' ? '1' : '0'}${preview.token.slice(1)}`;
    await executionError(host, CASE_CAPABILITIES.applyRollback, {
      caseId: record.id, checkpointId: checkpoint.id, expectedRevision: preview.expectedRevision,
      previewToken: changedToken, actor: '用户',
    });
    assert.deepEqual(await currentCase(host, record.id), before);
    assert.deepEqual(await checkpointList(host, record.id), checkpoints);
  } finally { await host.stop(); }
});
