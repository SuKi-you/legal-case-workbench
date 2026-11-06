import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createRuntime, CASE_CAPABILITIES, caseContentsSchema, caseHistorySchema, caseRecordSchema,
  exportedCaseFileSchema, materialSchema, storedCaseFileSchema, type CapabilityRef,
} from '../src/index.ts';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string', default: './runtime-data' } } });
const dataDir = values['data-dir'];
const runtime = await createRuntime({ dataDir });
async function call(host: typeof runtime, ref: CapabilityRef, input: unknown): Promise<unknown> {
  const result = await host.invoke(ref, input);
  if (result.status !== 'success') throw new Error(JSON.stringify(result));
  return result.data;
}
let caseA = '';
let caseB = '';
let materialA = '';
let fileA = '';
const attachment = fileURLToPath(new URL('./fixtures/case-note.txt', import.meta.url));
try {
  const a = caseRecordSchema.parse(await call(runtime, CASE_CAPABILITIES.create, {
    title: '虚构案件 A', caseNumber: 'DEMO-A', actor: '演示用户',
  }));
  const b = caseRecordSchema.parse(await call(runtime, CASE_CAPABILITIES.create, {
    title: '虚构案件 B', caseNumber: 'DEMO-B', actor: '演示用户',
  }));
  caseA = a.id; caseB = b.id;
  materialA = materialSchema.parse(await call(runtime, CASE_CAPABILITIES.registerText, {
    caseId: a.id, sourceLabel: 'A 案模拟记录', text: '仅属于案件 A 的文字。',
  })).id;
  await call(runtime, CASE_CAPABILITIES.registerText, {
    caseId: b.id, sourceLabel: 'B 案模拟记录', text: '仅属于案件 B 的文字。',
  });
  fileA = storedCaseFileSchema.parse(await call(runtime, CASE_CAPABILITIES.importFile, {
    caseId: a.id, path: attachment, sourceLabel: '虚构原始附件，仅验证字节存取',
  })).id;
  const currentA = caseRecordSchema.parse(await call(runtime, CASE_CAPABILITIES.read, { caseId: a.id }));
  const currentB = caseRecordSchema.parse(await call(runtime, CASE_CAPABILITIES.read, { caseId: b.id }));
  await call(runtime, CASE_CAPABILITIES.update, {
    caseId: a.id, expectedRevision: currentA.revision, actor: '演示用户', stage: '材料整理中', note: '已存入文字和附件。',
  });
  await call(runtime, CASE_CAPABILITIES.update, {
    caseId: b.id, expectedRevision: currentB.revision, actor: '演示用户', stage: '等待补充材料', status: 'paused',
  });
} finally { await runtime.stop(); }

const restarted = await createRuntime({ dataDir });
try {
  const a = caseContentsSchema.parse(await call(restarted, CASE_CAPABILITIES.contents, { caseId: caseA }));
  const b = caseContentsSchema.parse(await call(restarted, CASE_CAPABILITIES.contents, { caseId: caseB }));
  assert.equal(a.materials.length, 1); assert.equal(b.materials.length, 1);
  assert.equal(a.case.stage, '材料整理中'); assert.equal(b.case.status, 'paused');
  const materialDenied = await restarted.invoke(CASE_CAPABILITIES.readMaterial, { caseId: caseB, materialId: materialA });
  const fileDenied = await restarted.invoke(CASE_CAPABILITIES.readFile, { caseId: caseB, fileId: fileA });
  assert.equal(materialDenied.status, 'error'); assert.equal(fileDenied.status, 'error');
  const exported = exportedCaseFileSchema.parse(await call(restarted, CASE_CAPABILITIES.exportFile, {
    caseId: caseA, fileId: fileA, destination: join(dataDir, 'exports', `${caseA}-note.txt`),
  }));
  assert.deepEqual(await readFile(exported.destination), await readFile(attachment));
  const history = caseHistorySchema.parse(await call(restarted, CASE_CAPABILITIES.history, { caseId: caseA }));
  console.log(JSON.stringify({ caseA: a.case, caseB: b.case,
    materialAId: materialA, fileAId: fileA, caseAMaterialCount: a.materials.length, caseBMaterialCount: b.materials.length,
    caseAHistoryLength: history.length, exportedPath: exported.destination,
    restoredAfterRestart: true, crossCaseAccessRejected: true }, null, 2));
} finally { await restarted.stop(); }
