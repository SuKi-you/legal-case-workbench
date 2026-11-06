import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentToolCatalog } from '../src/agent-tools/catalog.ts';
import { createCaseTools } from '../src/agent-tools/case-tools.ts';
import type { AgentToolContext } from '../src/agent-tools/contracts.ts';
import { CaseError, CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace, CaseWriteStaleError } from '../src/cases/workspace.ts';

const statement = { text: '主管说不用来了。' };
const ref = { id: 'user.statement.register', version: 1 };
async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-write-preflight-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const cases = new CaseStore(dataDir), workspace = new CaseWorkspace(dataDir, cases);
  const record = await cases.create({ title: '纯虚构写入边界检查', actor: '离线自动验收' });
  const context: AgentToolContext = { caseId: record.id, operationId: randomUUID(), userMessage: statement.text, expectedCaseRevision: record.revision };
  const catalog = new AgentToolCatalog(createCaseTools({ dataDir }));
  return { dataDir, cases, workspace, record, context, catalog,
    lock: (operationId: string) => join(cases.directory(record.id), 'agent-operation-locks', `${operationId}.lock`) };
}

test('a stale pre-write fence leaves no material or uncertain marker and the same operation can retry', async t => {
  const f = await fixture(t);
  const current = await f.cases.update({ caseId: f.record.id, expectedRevision: f.record.revision, actor: '另一个操作者', stage: '已更新' });
  await assert.rejects(f.catalog.execute(ref, statement, f.context), error => error instanceof CaseWriteStaleError && error.code === 'CASE_REVISION_CONFLICT');
  assert.equal((await f.workspace.contents(f.record.id)).materials.length, 0);
  await assert.rejects(stat(f.lock(f.context.operationId)), { code: 'ENOENT' });
  assert.equal((await f.catalog.reconcile(ref, statement, f.context)).status, 'not_started');
  const fresh = { ...f.context, expectedCaseRevision: current.revision };
  const first = await f.catalog.execute(ref, statement, fresh);
  assert.deepEqual(await f.catalog.execute(ref, statement, fresh), first);
  assert.equal((await f.workspace.contents(f.record.id)).materials.length, 1);
});

test('an update immediately after tool preflight is distinguished from a final publication conflict', async t => {
  const f = await fixture(t), original = CaseWorkspace.prototype.registerText;
  let inject = true;
  CaseWorkspace.prototype.registerText = async function(input, options) {
    if (inject) {
      inject = false;
      const current = await f.cases.read(f.record.id);
      await f.cases.update({ caseId: current.id, expectedRevision: current.revision, actor: '并发操作者', stage: '紧邻竞争更新' });
    }
    return original.call(this, input, options);
  };
  try {
    await assert.rejects(f.catalog.execute(ref, statement, f.context), error => error instanceof CaseWriteStaleError && error.code === 'CASE_REVISION_CONFLICT');
  } finally { CaseWorkspace.prototype.registerText = original; }
  assert.equal((await f.workspace.contents(f.record.id)).materials.length, 0);
  assert.equal((await f.catalog.reconcile(ref, statement, f.context)).status, 'not_started');
  const current = await f.cases.read(f.record.id);
  await f.catalog.execute(ref, statement, { ...f.context, expectedCaseRevision: current.revision });
  assert.equal((await f.workspace.contents(f.record.id)).materials.length, 1);
});

test('a genuinely unknown started operation stays locked while a different operation remains independent', async t => {
  const f = await fixture(t), original = CaseWorkspace.prototype.registerText;
  CaseWorkspace.prototype.registerText = async function() { throw new Error('Unconfirmed outcome after operation started'); };
  try { await assert.rejects(f.catalog.execute(ref, statement, f.context), /Unconfirmed outcome/u); }
  finally { CaseWorkspace.prototype.registerText = original; }
  assert.equal((await f.catalog.reconcile(ref, statement, f.context)).status, 'unknown');
  assert.ok((await stat(f.lock(f.context.operationId))).isFile());
  await assert.rejects(f.catalog.execute(ref, statement, f.context), /TOOL_WRITE_UNCERTAIN/u);
  const independent = { ...f.context, operationId: randomUUID() };
  await f.catalog.execute(ref, statement, independent);
  assert.equal((await f.workspace.contents(f.record.id)).materials.length, 1);
  assert.equal((await f.catalog.reconcile(ref, statement, f.context)).status, 'unknown');
});

test('a final CAS-labelled error after a real commit retains the marker and reconciles the committed item', async t => {
  const f = await fixture(t), original = CaseWorkspace.prototype.registerText;
  CaseWorkspace.prototype.registerText = async function(input, options) {
    await original.call(this, input, options);
    throw new CaseError('CASE_REVISION_CONFLICT', 'Simulated late failure after publication');
  };
  try { await assert.rejects(f.catalog.execute(ref, statement, f.context), /CASE_REVISION_CONFLICT/u); }
  finally { CaseWorkspace.prototype.registerText = original; }
  assert.ok((await stat(f.lock(f.context.operationId))).isFile());
  assert.equal((await f.catalog.reconcile(ref, statement, f.context)).status, 'completed');
  await f.catalog.execute(ref, statement, f.context);
  assert.equal((await f.workspace.contents(f.record.id)).materials.length, 1);
});

test('a pre-existing unknown marker is never cleared merely because the expected case revision is stale', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.lock(f.context.operationId)), { recursive: true });
  await writeFile(f.lock(f.context.operationId), '{}');
  await f.cases.update({ caseId: f.record.id, expectedRevision: f.record.revision, actor: '并发操作者', stage: '已更新' });
  await assert.rejects(f.catalog.execute(ref, statement, f.context), /TOOL_WRITE_UNCERTAIN/u);
  assert.equal((await f.catalog.reconcile(ref, statement, f.context)).status, 'unknown');
  assert.ok((await stat(f.lock(f.context.operationId))).isFile());
});

test('file authorization is preflight: a rejected attachment can be corrected without an unknown-write lock', async t => {
  const f = await fixture(t), path = join(f.dataDir, 'only-fictional-attachment.txt');
  await writeFile(path, '仅用于检查授权的虚构文件');
  const fileRef = { id: 'material.file.register', version: 1 }, input = { path };
  await assert.rejects(f.catalog.execute(fileRef, input, f.context), /TOOL_PATH_NOT_ATTACHED/u);
  assert.equal((await f.catalog.reconcile(fileRef, input, f.context)).status, 'not_started');
  await f.catalog.execute(fileRef, input, { ...f.context, allowedPaths: [path] });
  assert.equal((await f.workspace.contents(f.record.id)).files.length, 1);
});
