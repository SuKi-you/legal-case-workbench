import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CASE_CAPABILITIES, MATERIAL_CAPABILITIES, caseContentsSchema, caseFileViewSchema,
  caseHistorySchema, caseListSchema, caseRecordSchema, caseRequestSchema,
  createRuntime, defineCapability, exportedCaseFileSchema, materialSchema,
  materialViewSchema, ocrAttemptSchema, resolvedReferenceSchema, sourceReferenceSchema,
  storedCaseFileSchema, textVersionSchema, textVersionsSchema, textVersionViewSchema,
  type CapabilityRef, type OcrAdapter, type PluginDefinition, type PluginHost,
} from '../src/index.ts';

const image = fileURLToPath(new URL('../examples/fixtures/ocr-sample.png', import.meta.url));

function fakeOcr(): OcrAdapter {
  return {
    engine: { id: 'test-only-case-ocr', version: '1', languages: ['chi_sim'] },
    recognize: async () => ({
      text: '模拟图像工资8000元', confidence: 70,
      lines: [{ text: '模拟图像工资8000元', confidence: 70, box: { x0: 2, y0: 3, x1: 180, y1: 40 } }],
    }),
    close: async () => {},
  };
}

async function directoryFor(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-case-workflow-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), 'law-agent-case-workflow-')));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function invoke(host: PluginHost, capability: CapabilityRef, input: unknown): Promise<unknown> {
  const result = await host.invoke(capability, input);
  if (result.status !== 'success') assert.fail(JSON.stringify(result));
  return result.data;
}

async function expectHostError(
  host: PluginHost, capability: CapabilityRef, input: unknown,
  code: 'INPUT_INVALID' | 'EXECUTION_FAILED',
): Promise<string> {
  const result = await host.invoke(capability, input);
  if (result.status !== 'error') assert.fail(`Expected ${code}: ${JSON.stringify(result)}`);
  assert.equal(result.error.code, code);
  assert.ok(result.error.message.length > 0);
  return result.error.message;
}

test('case projects preserve separate materials, original attachments, progress and history across restart', async (t) => {
  const dataDir = await directoryFor(t);
  // These are deliberately fictional raw bytes, not valid documents to parse.
  const pdfBytes = Buffer.from('%PDF-1.7\nfictional attachment\n\0\x01', 'utf8');
  const wordBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 255]);
  const pdf = join(dataDir, 'fictional.pdf');
  const word = join(dataDir, 'fictional.docx');
  await writeFile(pdf, pdfBytes);
  await writeFile(word, wordBytes);
  const runtime = await createRuntime({ dataDir, ocr: fakeOcr() });
  let aId = '';
  let bId = '';
  let aTextId = '';
  let aFileId = '';
  let bFileId = '';
  let aImageId = '';
  let bImageId = '';
  try {
    assert.equal(runtime.listCapabilities().length, Object.keys(MATERIAL_CAPABILITIES).length + Object.keys(CASE_CAPABILITIES).length);
    assert.deepEqual(
      new Set(runtime.listCapabilities().map((capability) => capability.id)),
      new Set([...Object.values(MATERIAL_CAPABILITIES), ...Object.values(CASE_CAPABILITIES)]
        .map((capability) => capability.id)),
    );
    const a = caseRecordSchema.parse(await invoke(runtime, CASE_CAPABILITIES.create, {
      title: '虚构项目甲', caseNumber: 'TEST-A', stage: '接案登记', actor: '测试律师',
    }));
    const b = caseRecordSchema.parse(await invoke(runtime, CASE_CAPABILITIES.create, {
      title: '虚构项目乙', caseNumber: 'TEST-B', actor: '测试律师',
    }));
    aId = a.id;
    bId = b.id;
    const aText = materialSchema.parse(await invoke(runtime, CASE_CAPABILITIES.registerText, {
      caseId: a.id, sourceLabel: '甲案陈述', text: '甲案原文8000元。',
    }));
    aTextId = aText.id;
    const bText = materialSchema.parse(await invoke(runtime, CASE_CAPABILITIES.registerText, {
      caseId: b.id, sourceLabel: '乙案陈述', text: '乙案原文5000元。',
    }));
    assert.equal(aText.groupId, a.id);
    assert.equal(bText.groupId, b.id);
    for (const [record, sourceLabel] of [[a, '甲案图片'], [b, '乙案图片']] as const) {
      const material = materialSchema.parse(await invoke(runtime, CASE_CAPABILITIES.registerImage, {
        caseId: record.id, sourceLabel, path: image,
      }));
      const attempt = ocrAttemptSchema.parse(await invoke(runtime, CASE_CAPABILITIES.recognize, {
        caseId: record.id, materialId: material.id,
      }));
      assert.equal(attempt.status, 'success');
      if (record.id === a.id) aImageId = material.id;
      else bImageId = material.id;
    }
    aFileId = storedCaseFileSchema.parse(await invoke(runtime, CASE_CAPABILITIES.importFile, {
      caseId: a.id, path: pdf, sourceLabel: '甲案原始PDF附件（不解析）',
    })).id;
    bFileId = storedCaseFileSchema.parse(await invoke(runtime, CASE_CAPABILITIES.importFile, {
      caseId: b.id, path: word, sourceLabel: '乙案原始Word附件（不解析）',
    })).id;
    const aBeforeUpdate = caseRecordSchema.parse(await invoke(runtime, CASE_CAPABILITIES.read, { caseId: a.id }));
    const aUpdated = caseRecordSchema.parse(await invoke(runtime, CASE_CAPABILITIES.update, {
      caseId: a.id, expectedRevision: aBeforeUpdate.revision, status: 'paused', stage: '等待补充材料',
      actor: '测试律师', note: '手工标记，与法律分析无关。',
    }));
    assert.ok(aBeforeUpdate.revision > a.revision, 'Material, OCR and attachment saves must advance the case revision.');
    assert.equal(aUpdated.revision, aBeforeUpdate.revision + 1);
    const bBeforeUpdate = caseRecordSchema.parse(await invoke(runtime, CASE_CAPABILITIES.read, { caseId: b.id }));
    await invoke(runtime, CASE_CAPABILITIES.update, {
      caseId: b.id, expectedRevision: bBeforeUpdate.revision, status: 'closed', stage: '办理记录已整理', actor: '测试律师',
    });
    // Closed is a progress label, so explicitly selected cases remain writable.
    await invoke(runtime, CASE_CAPABILITIES.registerText, {
      caseId: b.id, sourceLabel: '关闭标记后的补充', text: '结案记录仍可追加保存。',
    });
  } finally { await runtime.stop(); }

  const restarted = await createRuntime({ dataDir, ocr: fakeOcr() });
  try {
    const a = caseContentsSchema.parse(await invoke(restarted, CASE_CAPABILITIES.contents, { caseId: aId }));
    const b = caseContentsSchema.parse(await invoke(restarted, CASE_CAPABILITIES.contents, { caseId: bId }));
    assert.equal(a.case.stage, '等待补充材料');
    assert.equal(a.case.status, 'paused');
    assert.equal(b.case.status, 'closed');
    assert.equal(a.materials.length, 2);
    assert.equal(b.materials.length, 3);
    assert.ok(a.materials.every((material) => material.groupId === aId));
    assert.ok(b.materials.every((material) => material.groupId === bId));
    assert.deepEqual(a.files.map((file) => file.id), [aFileId]);
    assert.deepEqual(b.files.map((file) => file.id), [bFileId]);
    const history = caseHistorySchema.parse(await invoke(restarted, CASE_CAPABILITIES.history, { caseId: aId }));
    assert.ok(history.filter((event) => event.kind === 'workspace_updated').length >= 4);
    assert.deepEqual(history.map((event) => event.revision), Array.from({ length: history.length }, (_, index) => index + 1));
    const progressUpdate = history[history.length - 1]!;
    assert.equal(progressUpdate.kind, 'updated');
    assert.equal(progressUpdate.record.stage, a.case.stage);
    assert.equal(progressUpdate.record.revision, a.case.revision);
    assert.equal(progressUpdate.actor, '测试律师');
    const selected = caseListSchema.parse(await invoke(restarted, CASE_CAPABILITIES.list, {
      query: 'TEST-A', status: 'paused',
    }));
    assert.deepEqual(selected.cases.map((record) => record.id), [aId]);
    assert.deepEqual(selected.unavailable, []);
    for (const [caseId, materialId] of [[aId, aImageId], [bId, bImageId]] as const) {
      const view = materialViewSchema.parse(await invoke(restarted, CASE_CAPABILITIES.readMaterial, { caseId, materialId }));
      assert.equal(view.ocrAttempts.length, 1);
      assert.deepEqual(await readFile(view.originalPath), await readFile(image));
    }
    const rawA = caseFileViewSchema.parse(await invoke(restarted, CASE_CAPABILITIES.readFile, { caseId: aId, fileId: aFileId }));
    const rawB = caseFileViewSchema.parse(await invoke(restarted, CASE_CAPABILITIES.readFile, { caseId: bId, fileId: bFileId }));
    assert.deepEqual(await readFile(rawA.originalPath), pdfBytes);
    assert.deepEqual(await readFile(rawB.originalPath), wordBytes);
    const destination = join(dataDir, 'exports', 'copy.pdf');
    const exported = exportedCaseFileSchema.parse(await invoke(restarted, CASE_CAPABILITIES.exportFile, {
      caseId: aId, fileId: aFileId, destination,
    }));
    assert.equal(exported.destination, destination);
    assert.deepEqual(await readFile(destination), pdfBytes);
    const textDestination = join(dataDir, 'exports', 'statement.txt');
    await invoke(restarted, CASE_CAPABILITIES.exportMaterial, {
      caseId: aId, materialId: aTextId, destination: textDestination,
    });
    assert.equal(await readFile(textDestination, 'utf8'), '甲案原文8000元。');
  } finally { await restarted.stop(); }
});

test('case protocols never resolve another case or legacy-global resource by its identifier', async (t) => {
  const dataDir = await directoryFor(t);
  const pdf = join(dataDir, 'fictional.pdf');
  await writeFile(pdf, '%PDF-1.7\nfixture bytes only');
  const runtime = await createRuntime({ dataDir, ocr: fakeOcr() });
  try {
    const a = caseRecordSchema.parse(await invoke(runtime, CASE_CAPABILITIES.create, { title: '甲案', actor: '用户' }));
    const b = caseRecordSchema.parse(await invoke(runtime, CASE_CAPABILITIES.create, { title: '乙案', actor: '用户' }));
    const aText = materialSchema.parse(await invoke(runtime, CASE_CAPABILITIES.registerText, {
      caseId: a.id, sourceLabel: '甲案文字', text: '工资8000元',
    }));
    const bText = materialSchema.parse(await invoke(runtime, CASE_CAPABILITIES.registerText, {
      caseId: b.id, sourceLabel: '乙案文字', text: '工资5000元',
    }));
    const base = textVersionViewSchema.parse(await invoke(runtime, CASE_CAPABILITIES.readVersion, {
      caseId: a.id, materialId: aText.id, versionId: aText.id,
    })).version;
    const revision = textVersionSchema.parse(await invoke(runtime, CASE_CAPABILITIES.saveRevision, {
      caseId: a.id, materialId: aText.id, baseVersionId: base.id, baseTextSha256: base.textSha256,
      text: '工资6000元', editor: '甲案编辑者',
    }));
    const reference = sourceReferenceSchema.parse(await invoke(runtime, CASE_CAPABILITIES.createReference, {
      caseId: a.id, materialId: aText.id, versionId: revision.id, start: 2, end: 6, quote: '6000',
    }));
    const file = storedCaseFileSchema.parse(await invoke(runtime, CASE_CAPABILITIES.importFile, {
      caseId: a.id, path: pdf, sourceLabel: '甲案附件',
    }));
    const materialCalls: readonly [CapabilityRef, unknown][] = [
      [CASE_CAPABILITIES.readMaterial, { caseId: b.id, materialId: aText.id }],
      [CASE_CAPABILITIES.listVersions, { caseId: b.id, materialId: aText.id }],
      [CASE_CAPABILITIES.readVersion, { caseId: b.id, materialId: aText.id, versionId: revision.id }],
      [CASE_CAPABILITIES.saveRevision, {
        caseId: b.id, materialId: aText.id, baseVersionId: base.id, baseTextSha256: base.textSha256,
        text: '跨案编辑必须拒绝', editor: '用户',
      }],
      [CASE_CAPABILITIES.createReference, { caseId: b.id, materialId: aText.id, versionId: revision.id, start: 2, end: 6, quote: '6000' }],
      [CASE_CAPABILITIES.resolveReference, { caseId: b.id, materialId: aText.id, referenceId: reference.id }],
      [CASE_CAPABILITIES.recognize, { caseId: b.id, materialId: aText.id }],
    ];
    for (const [capability, input] of materialCalls) {
      assert.match(await expectHostError(runtime, capability, input, 'EXECUTION_FAILED'), /MATERIAL_NOT_FOUND/);
    }
    assert.match(await expectHostError(runtime, CASE_CAPABILITIES.readVersion, {
      caseId: b.id, materialId: bText.id, versionId: revision.id,
    }, 'EXECUTION_FAILED'), /CASE_VERSION_NOT_ACTIVE/);
    assert.match(await expectHostError(runtime, CASE_CAPABILITIES.resolveReference, {
      caseId: b.id, materialId: bText.id, referenceId: reference.id,
    }, 'EXECUTION_FAILED'), /REFERENCE_NOT_FOUND/);
    for (const capability of [CASE_CAPABILITIES.readFile, CASE_CAPABILITIES.exportFile]) {
      const request = { caseId: b.id, fileId: file.id,
        ...(capability === CASE_CAPABILITIES.exportFile ? { destination: join(dataDir, 'should-not-exist.pdf') } : {}) };
      assert.match(await expectHostError(runtime, capability, request, 'EXECUTION_FAILED'), /CASE_FILE_NOT_FOUND/);
    }
    const legacy = materialSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.registerText, {
      groupId: a.id, sourceLabel: '旧全局材料，分组名字恰好同案件ID', text: '不能自动归入甲案。',
    }));
    assert.match(await expectHostError(runtime, CASE_CAPABILITIES.readMaterial, {
      caseId: a.id, materialId: legacy.id,
    }, 'EXECUTION_FAILED'), /MATERIAL_NOT_FOUND/);
    assert.match(await expectHostError(runtime, MATERIAL_CAPABILITIES.read, { materialId: aText.id }, 'EXECUTION_FAILED'), /MATERIAL_NOT_FOUND/);
    const own = resolvedReferenceSchema.parse(await invoke(runtime, CASE_CAPABILITIES.resolveReference, {
      caseId: a.id, materialId: aText.id, referenceId: reference.id,
    }));
    assert.equal(own.reference.quote, '6000');
    assert.equal(textVersionsSchema.parse(await invoke(runtime, CASE_CAPABILITIES.listVersions, {
      caseId: b.id, materialId: bText.id,
    })).length, 1);
    assert.deepEqual(caseContentsSchema.parse(await invoke(runtime, CASE_CAPABILITIES.contents, { caseId: a.id })).materials.map((material) => material.id), [aText.id]);
  } finally { await runtime.stop(); }
});

test('an independent plugin reads the explicitly chosen case through declared public capabilities only', async (t) => {
  const dataDir = await directoryFor(t);
  const consumerRef = { id: 'test.case-consumer', version: 1 };
  const consumer: PluginDefinition = {
    manifest: { id: 'independent.case-consumer', version: '1', apiVersion: 1,
      requires: [CASE_CAPABILITIES.read, CASE_CAPABILITIES.contents] },
    capabilities: [defineCapability({
      ...consumerRef, input: caseRequestSchema, output: caseContentsSchema,
      execute: async (input, context) => {
        const record = await context.invoke(CASE_CAPABILITIES.read, input);
        const contents = await context.invoke(CASE_CAPABILITIES.contents, input);
        if (record.status !== 'success' || contents.status !== 'success') throw new Error('Case consumer could not load its selected case.');
        const parsedRecord = caseRecordSchema.parse(record.data);
        const parsedContents = caseContentsSchema.parse(contents.data);
        assert.equal(parsedRecord.id, input.caseId);
        assert.equal(parsedContents.case.id, input.caseId);
        return { status: 'success', data: parsedContents };
      },
    })],
  };
  const runtime = await createRuntime({ dataDir, ocr: fakeOcr(), plugins: [consumer] });
  try {
    const a = caseRecordSchema.parse(await invoke(runtime, CASE_CAPABILITIES.create, { title: '消费者甲案', actor: '用户' }));
    const b = caseRecordSchema.parse(await invoke(runtime, CASE_CAPABILITIES.create, { title: '消费者乙案', actor: '用户' }));
    await invoke(runtime, CASE_CAPABILITIES.registerText, { caseId: a.id, sourceLabel: '甲案材料', text: '仅甲案可见。' });
    const aResult = await runtime.invoke(consumerRef, { caseId: a.id });
    if (aResult.status !== 'success') assert.fail(JSON.stringify(aResult));
    assert.equal(aResult.meta.provider?.id, consumer.manifest.id);
    assert.equal(caseContentsSchema.parse(aResult.data).materials.length, 1);
    const bContents = caseContentsSchema.parse(await invoke(runtime, consumerRef, { caseId: b.id }));
    assert.equal(bContents.case.title, '消费者乙案');
    assert.deepEqual(bContents.materials, []);
  } finally { await runtime.stop(); }
});

test('case input contracts reject implicit identities, path traversal and a caller-forged material group', async (t) => {
  const runtime = await createRuntime({ dataDir: await directoryFor(t), ocr: fakeOcr() });
  try {
    const record = caseRecordSchema.parse(await invoke(runtime, CASE_CAPABILITIES.create, { title: '输入校验案', actor: '用户' }));
    const before = caseContentsSchema.parse(await invoke(runtime, CASE_CAPABILITIES.contents, { caseId: record.id }));
    const requests: readonly [CapabilityRef, unknown][] = [
      [CASE_CAPABILITIES.read, { caseId: '../outside' }],
      [CASE_CAPABILITIES.contents, { caseId: 'current' }],
      [CASE_CAPABILITIES.registerText, { caseId: record.id, groupId: randomUUID(), sourceLabel: '不能伪造分组', text: '测试' }],
      [CASE_CAPABILITIES.registerImage, { caseId: record.id, groupId: record.id, sourceLabel: '不能传入分组', path: image }],
      [CASE_CAPABILITIES.readMaterial, { caseId: '../outside', materialId: randomUUID() }],
      [CASE_CAPABILITIES.update, { caseId: record.id, expectedRevision: 0, actor: '用户', stage: '非法版本' }],
      [CASE_CAPABILITIES.readFile, { caseId: record.id, fileId: '../outside' }],
    ];
    for (const [capability, input] of requests) {
      await expectHostError(runtime, capability, input, 'INPUT_INVALID');
    }
    const contents = caseContentsSchema.parse(await invoke(runtime, CASE_CAPABILITIES.contents, { caseId: record.id }));
    assert.deepEqual(contents.materials, []);
    assert.deepEqual(contents.files, []);
    assert.deepEqual(contents, before);
  } finally { await runtime.stop(); }
});

test('independent runtimes cannot silently overwrite one another when updating the same case revision', async (t) => {
  const dataDir = await directoryFor(t);
  const first = await createRuntime({ dataDir, ocr: fakeOcr() });
  const second = await createRuntime({ dataDir, ocr: fakeOcr() });
  try {
    const record = caseRecordSchema.parse(await invoke(first, CASE_CAPABILITIES.create, { title: '并发进度案', actor: '用户' }));
    const current = caseRecordSchema.parse(await invoke(first, CASE_CAPABILITIES.read, { caseId: record.id }));
    const outcomes = await Promise.all([
      first.invoke(CASE_CAPABILITIES.update, { caseId: record.id, expectedRevision: current.revision, actor: '窗口一', stage: '材料整理' }),
      second.invoke(CASE_CAPABILITIES.update, { caseId: record.id, expectedRevision: current.revision, actor: '窗口二', stage: '人工核对' }),
    ]);
    const winners = outcomes.filter((result) => result.status === 'success');
    const conflicts = outcomes.filter((result) => result.status === 'error');
    assert.equal(winners.length, 1);
    assert.equal(conflicts.length, 1);
    const conflict = conflicts[0]!;
    if (conflict.status !== 'error') assert.fail('Expected a rejected conflicting update');
    assert.equal(conflict.error.code, 'EXECUTION_FAILED');
    assert.match(conflict.error.message, /CONFLICT|CHANGED/);
    const winner = winners[0]!;
    if (winner.status !== 'success') assert.fail('Expected one committed update');
    const saved = caseRecordSchema.parse(winner.data);
    const restored = caseRecordSchema.parse(await invoke(second, CASE_CAPABILITIES.read, { caseId: record.id }));
    assert.equal(restored.revision, current.revision + 1);
    assert.equal(restored.stage, saved.stage);
    const history = caseHistorySchema.parse(await invoke(first, CASE_CAPABILITIES.history, { caseId: record.id }));
    assert.equal(history.length, current.revision + 1);
    assert.equal(history[history.length - 1]!.kind, 'updated');
    assert.equal(history[history.length - 1]!.record.stage, saved.stage);
    assert.equal(history[history.length - 1]!.parentId, history[history.length - 2]!.id);
  } finally {
    await first.stop();
    await second.stop();
  }
});
