import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import {
  createRuntime, MATERIAL_CAPABILITIES, materialSchema, materialViewSchema,
  resolvedReferenceSchema, sourceReferenceSchema, textVersionSchema, textVersionViewSchema,
  type CapabilityRef,
} from '../src/index.ts';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string', default: './runtime-data' } } });
const dataDir = values['data-dir'];
const runtime = await createRuntime({ dataDir });
async function invoke(host: typeof runtime, ref: CapabilityRef, input: unknown) {
  const result = await host.invoke(ref, input);
  if (result.status !== 'success') throw new Error(JSON.stringify(result));
  return result.data;
}
let materialId = '';
let oldReferenceId = '';
let newReferenceId = '';
try {
  const material = materialSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.registerText, {
    groupId: 'version-demo', sourceLabel: '虚构文字：仅用于修订及引用演示', text: '模拟记录：金额8000元。',
  }));
  materialId = material.id;
  const original = textVersionViewSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.readVersion, {
    materialId, versionId: materialId,
  })).version;
  const oldQuote = '8000元';
  const oldStart = original.text.indexOf(oldQuote);
  const oldReference = sourceReferenceSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.createReference, {
    materialId, versionId: original.id, start: oldStart, end: oldStart + oldQuote.length, quote: oldQuote,
  }));
  oldReferenceId = oldReference.id;
  const revision = textVersionSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.saveRevision, {
    materialId, baseVersionId: original.id, baseTextSha256: original.textSha256,
    text: '模拟记录：金额6000元。', editor: '演示用户', note: '虚构更正，用于验证保存新版本',
  }));
  const newQuote = '6000元';
  const newStart = revision.text.indexOf(newQuote);
  const newReference = sourceReferenceSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.createReference, {
    materialId, versionId: revision.id, start: newStart, end: newStart + newQuote.length, quote: newQuote,
  }));
  newReferenceId = newReference.id;
  const saved = materialViewSchema.parse(await invoke(runtime, MATERIAL_CAPABILITIES.read, { materialId }));
  assert.equal(saved.text, original.text);
  console.log(JSON.stringify({ materialId, originalVersionId: original.id, revisionVersionId: revision.id,
    originalUnchanged: saved.text, editedText: revision.text, oldReferenceId, newReferenceId }, null, 2));
} finally { await runtime.stop(); }

const restarted = await createRuntime({ dataDir });
try {
  for (const [referenceId, expected] of [[oldReferenceId, '8000元'], [newReferenceId, '6000元']] as const) {
    const resolved = resolvedReferenceSchema.parse(await invoke(restarted, MATERIAL_CAPABILITIES.resolveReference, {
      materialId, referenceId,
    }));
    assert.equal(resolved.reference.quote, expected);
    console.log(JSON.stringify({ restored: true, referenceId, versionId: resolved.version.id,
      quote: resolved.reference.quote, originalPath: resolved.originalPath }, null, 2));
  }
} finally { await restarted.stop(); }
