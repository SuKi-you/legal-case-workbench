import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createRuntime, defineCapability, MATERIAL_CAPABILITIES, materialSchema,
  materialViewSchema, ocrAttemptSchema, referenceRequestSchema,
  resolvedReferenceSchema, sourceReferenceSchema, textVersionSchema,
  textVersionsSchema, textVersionViewSchema,
  type CapabilityRef, type OcrAdapter, type PluginDefinition, type PluginHost,
} from '../src/index.ts';

const source = { groupId: 'workflow-001', sourceLabel: '虚构集成验收材料' };
const image = fileURLToPath(new URL('../examples/fixtures/ocr-sample.png', import.meta.url));

async function directoryFor(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-text-workflow-'));
  t.after(async () => {
    // Only remove the independently created test directory under the system temp root.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), 'law-agent-text-workflow-')));
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

test('nine built-in material capabilities preserve original and revised references across a full runtime restart', async (t) => {
  const dataDir = await directoryFor(t);
  const originalText = '😀 模拟材料：九月工资8000元。\r\n原始记载。';
  const revisedText = originalText.replace('8000', '6000');
  const originalQuote = '工资8000元';
  const revisedQuote = '工资6000元';
  const runtime = await createRuntime({ dataDir });
  let materialId = '';
  let oldReferenceId = '';
  let newReferenceId = '';
  let revisionId = '';
  try {
    assert.equal(runtime.listCapabilities().filter((capability) => capability.id.startsWith('materials.')).length, 9);
    assert.deepEqual(
      new Set(runtime.listCapabilities().filter((capability) => capability.id.startsWith('materials.')).map((capability) => capability.id)),
      new Set(Object.values(MATERIAL_CAPABILITIES).map((capability) => capability.id)),
    );
    const material = materialSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.registerText, {
      ...source, text: originalText,
    }));
    materialId = material.id;
    const versions = textVersionsSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.listVersions, { materialId }));
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.kind, 'original');
    assert.equal(versions[0]!.id, materialId);
    const base = textVersionViewSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.readVersion, {
      materialId, versionId: materialId,
    }));
    assert.equal(base.version.text, originalText);
    const oldReference = sourceReferenceSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.createReference, {
      materialId, versionId: materialId,
      start: originalText.indexOf(originalQuote),
      end: originalText.indexOf(originalQuote) + originalQuote.length,
      quote: originalQuote,
    }));
    oldReferenceId = oldReference.id;
    const revision = textVersionSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.saveRevision, {
      materialId, baseVersionId: materialId, baseTextSha256: base.version.textSha256,
      text: revisedText, editor: '验收用户', note: '对照原件直接更正文字。',
    }));
    assert.equal(revision.kind, 'revision');
    if (revision.kind !== 'revision') assert.fail('Expected a user revision');
    assert.equal(revision.baseVersionId, materialId);
    assert.equal(revision.baseTextSha256, base.version.textSha256);
    assert.equal(revision.review, 'user_edited');
    assert.equal(revision.text, revisedText);
    revisionId = revision.id;
    const newReference = sourceReferenceSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.createReference, {
      materialId, versionId: revision.id,
      start: revisedText.indexOf(revisedQuote),
      end: revisedText.indexOf(revisedQuote) + revisedQuote.length,
      quote: revisedQuote,
    }));
    newReferenceId = newReference.id;
    assert.equal(newReference.versionId, revision.id);
    assert.notEqual(newReference.textSha256, oldReference.textSha256);
  } finally { await runtime.stop(); }

  const restarted = await createRuntime({ dataDir });
  try {
    const old = resolvedReferenceSchema.parse(await invoke(restarted, MATERIAL_CAPABILITIES.resolveReference, {
      materialId, referenceId: oldReferenceId,
    }));
    const current = resolvedReferenceSchema.parse(await invoke(restarted, MATERIAL_CAPABILITIES.resolveReference, {
      materialId, referenceId: newReferenceId,
    }));
    assert.equal(old.reference.quote, originalQuote);
    assert.equal(old.version.text, originalText);
    assert.equal(current.reference.quote, revisedQuote);
    assert.equal(current.version.id, revisionId);
    assert.equal(current.version.text, revisedText);
    assert.equal(old.originalPath, current.originalPath);
    assert.equal(await readFile(current.originalPath, 'utf8'), originalText);
    const raw = materialViewSchema.parse(await invoke(restarted, MATERIAL_CAPABILITIES.read, { materialId }));
    assert.equal(raw.text, originalText);
    assert.deepEqual(raw.ocrAttempts, []);
    const versions = textVersionsSchema.parse(await invoke(restarted, MATERIAL_CAPABILITIES.listVersions, { materialId }));
    assert.equal(versions.length, 2);
    assert.deepEqual(new Set(versions.map((version) => version.id)), new Set([materialId, revisionId]));
  } finally { await restarted.stop(); }
});

test('an independent consumer resolves a revision reference solely through the public capability contract', async (t) => {
  const dataDir = await directoryFor(t);
  const consumerRef = { id: 'test.reference-consumer', version: 1 };
  const consumer: PluginDefinition = {
    manifest: {
      id: 'independent.reference-consumer', version: '1.0.0', apiVersion: 1,
      requires: [MATERIAL_CAPABILITIES.resolveReference],
    },
    capabilities: [defineCapability({
      ...consumerRef, input: referenceRequestSchema, output: resolvedReferenceSchema,
      execute: async (input, context) => {
        const result = await context.invoke(MATERIAL_CAPABILITIES.resolveReference, input);
        if (result.status !== 'success') throw new Error('Could not resolve the requested reference');
        return { status: 'success', data: resolvedReferenceSchema.parse(result.data) };
      },
    })],
  };
  const runtime = await createRuntime({ dataDir, plugins: [consumer] });
  try {
    const material = materialSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.registerText, {
      ...source, text: '模拟陈述：此前数字为8000。',
    }));
    const base = textVersionViewSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.readVersion, {
      materialId: material.id, versionId: material.id,
    }));
    const revision = textVersionSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.saveRevision, {
      materialId: material.id, baseVersionId: base.version.id, baseTextSha256: base.version.textSha256,
      text: '模拟陈述：更正为6000。', editor: '独立消费者的调用者',
    }));
    const quote = '6000';
    const reference = sourceReferenceSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.createReference, {
      materialId: material.id, versionId: revision.id, quote,
      start: revision.text.indexOf(quote), end: revision.text.indexOf(quote) + quote.length,
    }));
    const result = await runtime.invoke(consumerRef, { materialId: material.id, referenceId: reference.id });
    if (result.status !== 'success') assert.fail(JSON.stringify(result));
    assert.equal(result.meta.provider?.id, consumer.manifest.id);
    const resolved = resolvedReferenceSchema.parse(result.data);
    assert.equal(resolved.reference.quote, '6000');
    assert.equal(resolved.version.id, revision.id);
    assert.equal(resolved.version.kind, 'revision');
  } finally { await runtime.stop(); }
});

test('all five new capability inputs reject invalid requests before business execution', async (t) => {
  const runtime = await createRuntime({ dataDir: await directoryFor(t) });
  const id = randomUUID();
  try {
    const requests: readonly [CapabilityRef, unknown][] = [
      [MATERIAL_CAPABILITIES.listVersions, { materialId: '../outside' }],
      [MATERIAL_CAPABILITIES.readVersion, { materialId: id, versionId: 'latest' }],
      [MATERIAL_CAPABILITIES.saveRevision, {
        materialId: id, baseVersionId: id, text: '更正后文字', editor: '用户',
      }],
      [MATERIAL_CAPABILITIES.createReference, { materialId: id, versionId: id, start: 3, end: 2, quote: 'x' }],
      [MATERIAL_CAPABILITIES.resolveReference, { materialId: id, referenceId: 'latest' }],
    ];
    for (const [capability, input] of requests) {
      await expectHostError(runtime, capability, input, 'INPUT_INVALID');
    }
    await expectHostError(runtime, MATERIAL_CAPABILITIES.saveRevision, {
      materialId: id, baseVersionId: id, baseTextSha256: 'a'.repeat(64), editor: '用户', text: '\ud800',
    }, 'INPUT_INVALID');
  } finally { await runtime.stop(); }
});

test('validly shaped wrong versions, changed editor bases and mismatched quotes return execution errors', async (t) => {
  const runtime = await createRuntime({ dataDir: await directoryFor(t) });
  try {
    const material = materialSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.registerText, {
      ...source, text: '模拟工资8000元。',
    }));
    const other = materialSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.registerText, {
      ...source, text: '另一份独立材料。',
    }));
    assert.match(await expectHostError(runtime, MATERIAL_CAPABILITIES.readVersion, {
      materialId: material.id, versionId: randomUUID(),
    }, 'EXECUTION_FAILED'), /VERSION_NOT_FOUND/);
    assert.match(await expectHostError(runtime, MATERIAL_CAPABILITIES.readVersion, {
      materialId: material.id, versionId: other.id,
    }, 'EXECUTION_FAILED'), /VERSION_NOT_FOUND/);
    assert.match(await expectHostError(runtime, MATERIAL_CAPABILITIES.saveRevision, {
      materialId: material.id, baseVersionId: material.id, baseTextSha256: '0'.repeat(64),
      text: '模拟工资6000元。', editor: '用户',
    }, 'EXECUTION_FAILED'), /BASE_VERSION_CHANGED/);
    assert.match(await expectHostError(runtime, MATERIAL_CAPABILITIES.createReference, {
      materialId: material.id, versionId: material.id, start: 4, end: 8, quote: '6000',
    }, 'EXECUTION_FAILED'), /REFERENCE_QUOTE_MISMATCH/);
    assert.match(await expectHostError(runtime, MATERIAL_CAPABILITIES.createReference, {
      materialId: material.id, versionId: other.id, start: 0, end: 2, quote: '另一',
    }, 'EXECUTION_FAILED'), /VERSION_NOT_FOUND/);
    assert.match(await expectHostError(runtime, MATERIAL_CAPABILITIES.resolveReference, {
      materialId: material.id, referenceId: randomUUID(),
    }, 'EXECUTION_FAILED'), /REFERENCE_NOT_FOUND/);
    const versions = textVersionsSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.listVersions, {
      materialId: material.id,
    }));
    assert.equal(versions.length, 1);
  } finally { await runtime.stop(); }
});

test('OCR revisions keep the original image and recognized text while references explicitly select each version', async (t) => {
  const dataDir = await directoryFor(t);
  let attempts = 0;
  const adapter: OcrAdapter = {
    engine: { id: 'test-only-transcription', version: '1', languages: ['chi_sim'] },
    recognize: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Simulated OCR failure');
      return {
        text: '工资8000元', confidence: 70,
        lines: [{ text: '工资8000元', confidence: 70, box: { x0: 2, y0: 3, x1: 180, y1: 40 } }],
      };
    },
    close: async () => {},
  };
  const runtime = await createRuntime({ dataDir, ocr: adapter });
  try {
    const material = materialSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.registerImage, {
      ...source, path: image,
    }));
    const materialId = material.id;
    const failed = ocrAttemptSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.recognize, { materialId }));
    assert.equal(failed.status, 'failed');
    assert.deepEqual(await invoke(runtime, MATERIAL_CAPABILITIES.listVersions, { materialId }), []);
    const recognized = ocrAttemptSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.recognize, { materialId }));
    if (recognized.status !== 'success') assert.fail('Expected the simulated retry to produce text');
    const versions = textVersionsSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.listVersions, { materialId }));
    assert.equal(versions.length, 1);
    const base = versions[0]!;
    assert.equal(base.id, recognized.id);
    assert.equal(base.kind, 'ocr');
    const oldReference = sourceReferenceSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.createReference, {
      materialId, versionId: base.id, start: 2, end: 6, quote: '8000',
    }));
    const revision = textVersionSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.saveRevision, {
      materialId, baseVersionId: base.id, baseTextSha256: base.textSha256,
      text: '工资6000元', editor: '人工核对者',
    }));
    assert.equal(revision.kind, 'revision');
    assert.equal('lines' in revision, false);
    assert.equal('engine' in revision, false);
    const newReference = sourceReferenceSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.createReference, {
      materialId, versionId: revision.id, start: 2, end: 6, quote: '6000',
    }));
    const oldResolved = resolvedReferenceSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.resolveReference, {
      materialId, referenceId: oldReference.id,
    }));
    const newResolved = resolvedReferenceSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.resolveReference, {
      materialId, referenceId: newReference.id,
    }));
    assert.equal(oldResolved.reference.quote, '8000');
    assert.equal(oldResolved.version.kind, 'ocr');
    assert.equal(newResolved.reference.quote, '6000');
    assert.equal(newResolved.version.kind, 'revision');
    assert.equal(oldResolved.originalPath, newResolved.originalPath);
    assert.deepEqual(await readFile(newResolved.originalPath), await readFile(image));
    const raw = materialViewSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.read, { materialId }));
    assert.equal(raw.ocrAttempts.length, 2);
    const savedOcr = raw.ocrAttempts.find((attempt) => attempt.id === recognized.id);
    assert.ok(savedOcr?.status === 'success');
    assert.equal(savedOcr.output.text, '工资8000元');
    assert.equal(textVersionsSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.listVersions, { materialId })).length, 2);
  } finally { await runtime.stop(); }
});
