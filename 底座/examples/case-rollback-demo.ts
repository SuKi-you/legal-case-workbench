import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createRuntime, CASE_CAPABILITIES, caseCheckpointSchema, caseContentsSchema, caseRecordSchema,
  materialSchema, resolvedReferenceSchema, rollbackPreviewSchema, rollbackResultSchema,
  sourceReferenceSchema, textVersionSchema, textVersionsSchema, textVersionViewSchema,
  type CapabilityRef,
} from '../src/index.ts';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string', default: './runtime-data' } } });
const dataDir = values['data-dir'];
const runtime = await createRuntime({ dataDir });
async function call(host: typeof runtime, ref: CapabilityRef, input: unknown): Promise<unknown> {
  const result = await host.invoke(ref, input);
  if (result.status !== 'success') throw new Error(JSON.stringify(result));
  return result.data;
}
let caseId = '';
let checkpointId = '';
let undoId = '';
let materialId = '';
let laterReferenceId = '';
try {
  const record = caseRecordSchema.parse(await call(runtime, CASE_CAPABILITIES.create, {
    title: '虚构案件：完整回滚演示', actor: '演示用户', stage: '接案登记',
  }));
  caseId = record.id;
  materialId = materialSchema.parse(await call(runtime, CASE_CAPABILITIES.registerText, {
    caseId, sourceLabel: '虚构文字，仅用于版本演示', text: '模拟金额8000元。',
  })).id;
  const original = textVersionViewSchema.parse(await call(runtime, CASE_CAPABILITIES.readVersion, {
    caseId, materialId, versionId: materialId,
  })).version;
  const checkpoint = caseCheckpointSchema.parse(await call(runtime, CASE_CAPABILITIES.createCheckpoint, {
    caseId, label: '补充材料前', actor: '演示用户',
  }));
  checkpointId = checkpoint.id;
  const revision = textVersionSchema.parse(await call(runtime, CASE_CAPABILITIES.saveRevision, {
    caseId, materialId, baseVersionId: original.id, baseTextSha256: original.textSha256,
    text: '模拟金额6000元。', editor: '演示用户',
  }));
  const start = revision.text.indexOf('6000元');
  laterReferenceId = sourceReferenceSchema.parse(await call(runtime, CASE_CAPABILITIES.createReference, {
    caseId, materialId, versionId: revision.id, start, end: start + '6000元'.length, quote: '6000元',
  })).id;
  await call(runtime, CASE_CAPABILITIES.registerText, { caseId, sourceLabel: '保存点之后的新材料', text: '稍后补充的虚构内容。' });
  await call(runtime, CASE_CAPABILITIES.importFile, { caseId, sourceLabel: '保存点之后的原始附件',
    path: fileURLToPath(new URL('./fixtures/case-note.txt', import.meta.url)) });
  const current = caseRecordSchema.parse(await call(runtime, CASE_CAPABILITIES.read, { caseId }));
  await call(runtime, CASE_CAPABILITIES.update, { caseId, expectedRevision: current.revision,
    actor: '演示用户', stage: '材料整理完成', status: 'paused' });
  const preview = rollbackPreviewSchema.parse(await call(runtime, CASE_CAPABILITIES.previewRollback, { caseId, checkpointId }));
  console.log(JSON.stringify({ preview }, null, 2));
  const rolled = rollbackResultSchema.parse(await call(runtime, CASE_CAPABILITIES.applyRollback, {
    caseId, checkpointId, expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '演示用户',
  }));
  undoId = rolled.undoCheckpoint.id;
} finally { await runtime.stop(); }

const restarted = await createRuntime({ dataDir });
try {
  const restored = caseContentsSchema.parse(await call(restarted, CASE_CAPABILITIES.contents, { caseId }));
  assert.equal(restored.materials.length, 1); assert.equal(restored.files.length, 0);
  assert.equal(restored.case.stage, '接案登记');
  const versions = textVersionsSchema.parse(await call(restarted, CASE_CAPABILITIES.listVersions, { caseId, materialId }));
  assert.equal(versions.length, 1); assert.equal(versions[0]!.text, '模拟金额8000元。');
  const historySource = resolvedReferenceSchema.parse(await call(restarted, CASE_CAPABILITIES.resolveReference, {
    caseId, materialId, referenceId: laterReferenceId,
  }));
  assert.equal(historySource.reference.quote, '6000元');
  const preview = rollbackPreviewSchema.parse(await call(restarted, CASE_CAPABILITIES.previewRollback, { caseId, checkpointId: undoId }));
  await call(restarted, CASE_CAPABILITIES.applyRollback, { caseId, checkpointId: undoId,
    expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '演示用户', note: '撤销上一次回滚' });
  const undone = caseContentsSchema.parse(await call(restarted, CASE_CAPABILITIES.contents, { caseId }));
  assert.equal(undone.materials.length, 2); assert.equal(undone.files.length, 1);
  assert.equal(undone.case.stage, '材料整理完成');
  console.log(JSON.stringify({ caseId, checkpointId, autoUndoCheckpointId: undoId,
    restoredAfterRestart: true, originalTextInRestoredView: versions[0]!.text,
    laterReferenceStillVerifiable: historySource.reference.quote, rollbackUndone: true,
    finalMaterialCount: undone.materials.length, finalFileCount: undone.files.length, finalStage: undone.case.stage }, null, 2));
} finally { await restarted.stop(); }
