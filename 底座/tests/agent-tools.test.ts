import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { defineCapability, type AgentCapabilityMetadata } from '../src/contracts.ts';
import { createHost } from '../src/host.ts';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { CaseRollback } from '../src/cases/rollback.ts';
import { createCaseTools } from '../src/agent-tools/case-tools.ts';
import { AgentToolCatalog, createHostAgentTools } from '../src/agent-tools/catalog.ts';
import { AgentToolError, defineAgentTool, type AgentToolContext } from '../src/agent-tools/contracts.ts';
import type { OcrAdapter } from '../src/materials/contracts.ts';

const code = (value: string) => (error: unknown) => error instanceof AgentToolError && error.code === value;
const toolRef = (id: string) => ({ id, version: 1 });
async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'law-agent-tools-'));
  t.after(async () => {
    assert.equal(dirname(resolve(path)), resolve(tmpdir())); await rm(path, { recursive: true, force: true });
  }); return path;
}
async function fixture(t: TestContext, ocr?: OcrAdapter) {
  const dataDir = await directory(t), cases = new CaseStore(dataDir), workspace = new CaseWorkspace(dataDir, cases);
  const first = await cases.create({ title: '虚构接案工具检查', actor: '测试' });
  const second = await cases.create({ title: '独立案件', actor: '测试' });
  const context: AgentToolContext = { caseId: first.id, operationId: randomUUID(), userMessage: '补充：上周主管让我别来了。' };
  const tools = createCaseTools({ dataDir, ...(ocr ? { ocr } : {}) }), catalog = new AgentToolCatalog(tools);
  return { dataDir, cases, workspace, first, second, context, tools, catalog };
}

test('capability metadata is optional, validated before setup and isolated from original and listed objects', async () => {
  const inputSchema = { type: 'object', properties: { number: { type: 'number' } }, required: ['number'], additionalProperties: false };
  const metadata: AgentCapabilityMetadata = { description: '返回一个数值', effect: 'read', inputSchema };
  const capability = defineCapability({ id: 'test.exposed', version: 1, input: z.strictObject({ number: z.number() }), output: z.number(), agent: metadata,
    execute: async ({ number }) => ({ status: 'success', data: number }) });
  const hidden = defineCapability({ id: 'test.hidden', version: 1, input: z.null(), output: z.null(), execute: () => ({ status: 'success', data: null }) });
  const host = await createHost({ plugins: [{ manifest: { id: 'test.provider', version: '1', apiVersion: 1 }, capabilities: [capability, hidden],
    setup: () => { inputSchema.properties.number.type = 'string'; } }] });
  try {
    assert.equal((host.listCapabilities()[0]!.agent!.inputSchema.properties as typeof inputSchema.properties).number.type, 'number');
    (host.listCapabilities()[0]!.agent!.inputSchema.properties as typeof inputSchema.properties).number.type = 'boolean';
    assert.equal((host.listCapabilities()[0]!.agent!.inputSchema.properties as typeof inputSchema.properties).number.type, 'number');
    assert.equal(host.listCapabilities()[1]!.agent, undefined);
    const tools = createHostAgentTools(host); assert.equal(tools.length, 1); assert.equal(tools[0]!.id, 'test.exposed');
  } finally { await host.stop(); }
  for (const agent of [{ description: '', effect: 'read', inputSchema: {} }, { description: 'invalid', effect: 'read', inputSchema: { f() {} } },
    { description: 'invalid', effect: 'delete', inputSchema: {} }]) {
    let setup = false;
    await assert.rejects(createHost({ plugins: [{ manifest: { id: 'test.invalid', version: '1', apiVersion: 1 },
      capabilities: [{ ...capability, agent: agent as unknown as AgentCapabilityMetadata }], setup: () => { setup = true; } }] }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFIG_INVALID');
    assert.equal(setup, false);
  }
});

test('host plugin tools bind the session case and operation, validate domain inputs and can be replaced by configuration', async () => {
  const make = async (provider: string) => createHost({ plugins: [{ manifest: { id: provider, version: '1', apiVersion: 1 }, capabilities: [
    defineCapability({ id: 'plugin.lookup', version: 1,
      input: z.strictObject({ caseId: z.uuid(), operationId: z.uuid(), value: z.number().positive() }), output: z.record(z.string(), z.json()),
      agent: { description: '插件独立提供的检索', effect: 'read', inputSchema: { type: 'object', properties: {
        caseId: { type: 'string' }, operationId: { type: 'string' }, value: { type: 'number' } }, required: ['caseId', 'operationId', 'value'] } },
      execute: async (input) => ({ status: 'success', data: { ...input, provider } }) }),
  ] }] });
  const context = { caseId: randomUUID(), operationId: randomUUID(), userMessage: '测试插件能力' };
  for (const provider of ['test.provider-a', 'test.provider-b']) {
    const host = await make(provider);
    try {
      const catalog = new AgentToolCatalog(createHostAgentTools(host));
      const schema = catalog.list()[0]!.inputSchema;
      assert.deepEqual(schema.required, ['value']); assert.deepEqual(Object.keys(schema.properties as object), ['value']);
      assert.deepEqual(await catalog.execute(toolRef('plugin.lookup'), { value: 2 }, context), { caseId: context.caseId, operationId: context.operationId, value: 2, provider });
      await assert.rejects(catalog.execute(toolRef('plugin.lookup'), { value: -1 }, context), code('TOOL_CAPABILITY_FAILED'));
      await assert.rejects(catalog.execute(toolRef('plugin.lookup'), { value: 2, caseId: randomUUID() }, context), code('TOOL_CASE_MISMATCH'));
      assert.equal(createHostAgentTools(host, { allow: [] }).length, 0);
    } finally { await host.stop(); }
  }
});

test('model-visible plugin metadata hides the revision fence and execution uses the server-owned revision', async () => {
  const host = await createHost({ plugins: [{ manifest: { id: 'test.revision-bound', version: '1', apiVersion: 1 }, capabilities: [
    defineCapability({ id: 'plugin.save', version: 1,
      input: z.strictObject({ caseId: z.uuid(), operationId: z.uuid(), expectedRevision: z.number().int().positive(), value: z.string() }),
      output: z.record(z.string(), z.json()),
      agent: { description: '按执行器版本保存', effect: 'write', inputSchema: { type: 'object', properties: {
        caseId: { type: 'string' }, operationId: { type: 'string' }, expectedRevision: { type: 'integer' }, value: { type: 'string' },
      }, required: ['caseId', 'operationId', 'expectedRevision', 'value'] } },
      execute: async (input) => ({ status: 'success', data: input }),
    }),
  ] }] });
  try {
    const catalog = new AgentToolCatalog(createHostAgentTools(host));
    const schema = catalog.list()[0]!.inputSchema;
    assert.deepEqual(schema.required, ['value']); assert.deepEqual(Object.keys(schema.properties as object), ['value']);
    const context = { caseId: randomUUID(), operationId: randomUUID(), userMessage: '按当前版本保存', expectedCaseRevision: 7 };
    assert.deepEqual(await catalog.execute(toolRef('plugin.save'), { value: '原话', expectedRevision: 999 }, context), {
      caseId: context.caseId, operationId: context.operationId, expectedRevision: 7, value: '原话',
    });
    const { expectedCaseRevision: _, ...withoutFence } = context;
    await assert.rejects(catalog.execute(toolRef('plugin.save'), { value: '原话', expectedRevision: 999 }, withoutFence), code('TOOL_REVISION_REQUIRED'));
  } finally { await host.stop(); }
});

test('catalog rejects unknown versions, nested cross-case requests and invalid inputs before execution', async () => {
  let calls = 0;
  const input = z.strictObject({ count: z.coerce.number().int().positive() });
  const tool = defineAgentTool({ id: 'test.count', version: 1, description: '计数', effect: 'read', input, inputSchema: { type: 'object' },
    execute: async ({ count }) => { calls += 1; return { count }; } });
  const catalog = new AgentToolCatalog([tool]);
  const context = { caseId: randomUUID(), operationId: randomUUID(), userMessage: '' };
  await assert.rejects(catalog.execute(toolRef('missing'), {}, context), code('TOOL_NOT_FOUND'));
  await assert.rejects(catalog.execute({ id: tool.id, version: 2 }, {}, context), code('TOOL_VERSION_MISMATCH'));
  await assert.rejects(catalog.execute(toolRef(tool.id), { count: 0 }, context), code('TOOL_INPUT_INVALID'));
  await assert.rejects(catalog.execute(toolRef(tool.id), { nested: { caseId: randomUUID() }, count: 1 }, context), code('TOOL_CASE_MISMATCH'));
  assert.equal(calls, 0);
  assert.deepEqual(await catalog.execute(toolRef(tool.id), { count: '2' }, context), { count: 2 });
  assert.equal(calls, 1);
  assert.throws(() => new AgentToolCatalog([tool, tool]), code('TOOL_CONFIG_INVALID'));
});

test('schema transformations cannot replace the case binding and unconfirmed plugin writes are never guessed safe to retry', async () => {
  let executed = false;
  const unsafe = defineAgentTool({ id: 'test.transform', version: 1, description: '检验转换后的案件范围', effect: 'read',
    input: z.strictObject({}).transform(() => ({ caseId: randomUUID() })), inputSchema: { type: 'object' },
    execute: async () => { executed = true; return {}; } });
  const write = defineAgentTool({ id: 'test.write', version: 1, description: '无恢复协议的专业插件写入', effect: 'write',
    input: z.strictObject({}), inputSchema: { type: 'object' }, execute: async () => ({ saved: true }) });
  const catalog = new AgentToolCatalog([unsafe, write]), context = { caseId: randomUUID(), operationId: randomUUID(), userMessage: '' };
  await assert.rejects(catalog.execute(toolRef(unsafe.id), {}, context), code('TOOL_CASE_MISMATCH'));
  assert.equal(executed, false);
  assert.equal((await catalog.reconcile(toolRef(write.id), {}, context)).status, 'unknown');
});

test('tool cancellation prevents new work, drops late reads and keeps committed write outcomes available to recovery', async () => {
  const controller = new AbortController(); let calls = 0;
  const tool = (id: string, effect: 'read' | 'write') => defineAgentTool({ id, effect, version: 1, description: '检查取消边界',
    input: z.strictObject({}), inputSchema: { type: 'object' }, execute: async () => { calls += 1; controller.abort(); return { complete: true }; } });
  const context = { caseId: randomUUID(), operationId: randomUUID(), userMessage: '', signal: controller.signal };
  const catalog = new AgentToolCatalog([tool('test.read', 'read'), tool('test.write', 'write')]);
  await assert.rejects(catalog.execute(toolRef('test.read'), {}, context), code('AGENT_CANCELLED'));
  await assert.rejects(catalog.execute(toolRef('test.write'), {}, context), code('AGENT_CANCELLED'));
  assert.equal(calls, 1);
  const active = new AbortController();
  const writer = new AgentToolCatalog([defineAgentTool({ id: 'test.write', effect: 'write', version: 1, description: '已提交的写入',
    input: z.strictObject({}), inputSchema: { type: 'object' }, execute: async () => { active.abort(); return { committed: true }; } })]);
  assert.deepEqual(await writer.execute(toolRef('test.write'), {}, { ...context, signal: active.signal }), { committed: true });
});

test('case tools preserve literal statements and reconcile a committed write across a new catalogue without duplicates', async (t) => {
  const { dataDir, workspace, context, catalog } = await fixture(t);
  const input = { text: '上周主管让我别来了。' };
  await assert.rejects(catalog.execute(toolRef('user.statement.register'), { text: '公司已违法解除劳动合同' }, context), code('TOOL_STATEMENT_NOT_PROVIDED'));
  assert.equal((await workspace.contents(context.caseId)).materials.length, 0);
  const first = await catalog.execute(toolRef('user.statement.register'), input, context) as { id: string };
  const restarted = new AgentToolCatalog(createCaseTools({ dataDir }));
  const reconciled = await restarted.reconcile(toolRef('user.statement.register'), input, context);
  assert.equal(reconciled.status, 'completed');
  assert.deepEqual(await restarted.execute(toolRef('user.statement.register'), input, context), first);
  assert.equal((await workspace.contents(context.caseId)).materials.length, 1);
  const saved = await workspace.readVersion({ caseId: context.caseId, materialId: first.id, versionId: first.id });
  assert.equal(saved.version.text, input.text);
  await assert.rejects(restarted.execute(toolRef('user.statement.register'), { text: '主管让我别来了。' }, context), code('TOOL_OPERATION_MISMATCH'));
});

test('simultaneous executions of one statement operation can publish only one material', async (t) => {
  const { workspace, context, catalog } = await fixture(t), input = { text: '上周主管让我别来了。' };
  const attempts = await Promise.allSettled([
    catalog.execute(toolRef('user.statement.register'), input, context),
    catalog.execute(toolRef('user.statement.register'), input, context),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  const failed = attempts.find((attempt) => attempt.status === 'rejected');
  assert.ok(failed && failed.status === 'rejected' && failed.reason instanceof AgentToolError
    && ['TOOL_OPERATION_BUSY', 'TOOL_WRITE_UNCERTAIN'].includes(failed.reason.code));
  assert.equal((await workspace.contents(context.caseId)).materials.length, 1);
  assert.equal((await catalog.reconcile(toolRef('user.statement.register'), input, context)).status, 'completed');
});

test('an operation marker reconciles a material saved before a missing receipt and rollback never silently replays it', async (t) => {
  const { dataDir, cases, workspace, context, catalog } = await fixture(t);
  const rollback = new CaseRollback(cases, workspace);
  const checkpoint = await rollback.createCheckpoint({ caseId: context.caseId, label: '登记前', actor: '测试' });
  const input = { text: '上周主管让我别来了。' };
  const material = await catalog.execute(toolRef('user.statement.register'), input, context) as { id: string };
  const receiptPath = join(cases.directory(context.caseId), 'agent-operation-receipts', `${context.operationId}.json`);
  await unlink(receiptPath);
  assert.equal((await catalog.reconcile(toolRef('user.statement.register'), input, context)).status, 'completed');
  // Restore the receipt before rollback; the immutable receipt is a trace, not an active-case pointer.
  await writeFile(receiptPath, JSON.stringify({ version: 1, caseId: context.caseId, operationId: context.operationId,
    toolId: 'user.statement.register', requestHash: (await import('node:crypto')).createHash('sha256')
      .update('user.statement.register\n{"text":"上周主管让我别来了。"}').digest('hex'), result: material }));
  const preview = await rollback.preview({ caseId: context.caseId, checkpointId: checkpoint.id });
  await rollback.apply({ caseId: context.caseId, checkpointId: checkpoint.id, expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '测试' });
  assert.equal((await catalog.reconcile(toolRef('user.statement.register'), input, context)).status, 'unknown');
  await assert.rejects(catalog.execute(toolRef('user.statement.register'), input, context), code('TOOL_WRITE_UNCERTAIN'));
  assert.equal((await new CaseWorkspace(dataDir).contents(context.caseId)).materials.length, 0);
});

test('uncertain write markers do not get blindly retried and stale revision fences cannot save a late statement', async (t) => {
  const { cases, workspace, context, catalog } = await fixture(t);
  const lockDirectory = join(cases.directory(context.caseId), 'agent-operation-locks');
  await mkdir(lockDirectory, { recursive: true }); await writeFile(join(lockDirectory, `${context.operationId}.lock`), '{}');
  assert.equal((await catalog.reconcile(toolRef('user.statement.register'), { text: '上周主管让我别来了。' }, context)).status, 'unknown');
  await assert.rejects(catalog.execute(toolRef('user.statement.register'), { text: '上周主管让我别来了。' }, context), code('TOOL_WRITE_UNCERTAIN'));
  const current = await cases.read(context.caseId);
  await workspace.registerText({ caseId: context.caseId, text: '别的保存', sourceLabel: '另一个窗口' });
  await assert.rejects(catalog.execute(toolRef('user.statement.register'), { text: '上周主管让我别来了。' },
    { ...context, operationId: randomUUID(), expectedCaseRevision: current.revision }), /CASE_REVISION_CONFLICT|CASE_WRITE_STALE/);
  assert.equal((await workspace.contents(context.caseId)).materials.length, 1);
});

test('material listing requires explicit version selection; range reads retain hash and never split surrogate pairs', async (t) => {
  const { workspace, context, second, catalog } = await fixture(t);
  const material = await workspace.registerText({ caseId: context.caseId, sourceLabel: '虚构长文本', text: '甲😀乙后续文字' });
  const other = await workspace.registerText({ caseId: second.id, sourceLabel: '另案原话', text: '不应读到' });
  const list = await catalog.execute(toolRef('case.materials'), {}, context) as { materials: { id: string; versions: { id: string; text?: string }[] }[] };
  assert.equal(list.materials[0]!.versions[0]!.text, undefined);
  await assert.rejects(catalog.execute(toolRef('material.read'), { materialId: material.id }, context), code('TOOL_INPUT_INVALID'));
  const read = await catalog.execute(toolRef('material.read'), { materialId: material.id, versionId: material.id, start: 2, maxChars: 1 }, context) as { text: string; start: number; end: number; hasMore: boolean; textSha256: string };
  assert.equal(read.text, '😀'); assert.equal(read.start, 1); assert.equal(read.end, 3); assert.equal(read.hasMore, true);
  assert.equal(read.textSha256.length, 64);
  await assert.rejects(catalog.execute(toolRef('material.read'), { materialId: other.id, versionId: other.id }, context), /CASE_MATERIAL_NOT_ACTIVE|MATERIAL_NOT_FOUND/);
});

test('file import only accepts attached paths and preserves original bytes across reconciliation', async (t) => {
  const { dataDir, workspace, context, catalog } = await fixture(t);
  const path = join(dataDir, '虚构附件.pdf'), bytes = Buffer.from('%PDF-fixture-only'); await writeFile(path, bytes);
  await assert.rejects(catalog.execute(toolRef('material.file.register'), { path }, context), code('TOOL_PATH_NOT_ATTACHED'));
  const allowed = { ...context, operationId: randomUUID(), allowedPaths: [path] };
  const file = await catalog.execute(toolRef('material.file.register'), { path }, allowed) as { id: string };
  assert.equal((await catalog.reconcile(toolRef('material.file.register'), { path }, allowed)).status, 'completed');
  const view = await workspace.readFile({ caseId: context.caseId, fileId: file.id });
  assert.deepEqual(await readFile(view.originalPath), bytes);
  assert.equal((await workspace.contents(context.caseId)).files.length, 1);
});

test('OCR receipts prevent repeated recognition and tools never send a text material to OCR', async (t) => {
  let calls = 0;
  const ocr: OcrAdapter = { engine: { id: 'fixture', version: '1', languages: ['chi_sim'] },
    recognize: async () => { calls += 1; return { text: '虚构OCR文字', confidence: 90, lines: [] }; }, close: async () => {} };
  const { dataDir, workspace, context, catalog } = await fixture(t, ocr);
  const text = await workspace.registerText({ caseId: context.caseId, sourceLabel: '文字', text: '不调用OCR' });
  await assert.rejects(catalog.execute(toolRef('image.ocr'), { materialId: text.id }, context), code('TOOL_NOT_IMAGE'));
  const path = join(dataDir, 'image.png');
  await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXuoAAAAASUVORK5CYII=', 'base64'));
  const image = await catalog.execute(toolRef('material.image.register'), { path }, { ...context, operationId: randomUUID(), allowedPaths: [path] }) as { id: string };
  const first = await catalog.execute(toolRef('image.ocr'), { materialId: image.id }, context);
  assert.equal((await catalog.reconcile(toolRef('image.ocr'), { materialId: image.id }, context)).status, 'completed');
  assert.deepEqual(await catalog.execute(toolRef('image.ocr'), { materialId: image.id }, context), first);
  assert.equal(calls, 1);
});
