import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CaseError, CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { CaseRollback } from '../src/cases/rollback.ts';
import { ExecutionStore, validateSavedExecutionSnapshot } from '../src/execution/store.ts';
import type { CaseWorkspaceState } from '../src/cases/contracts.ts';
import type { OcrAdapter } from '../src/materials/contracts.ts';

const code = (expected: string) => (error: unknown) => error instanceof CaseError && error.code === expected;
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-execution-'));
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const cases = new CaseStore(directory), workspace = new CaseWorkspace(directory, cases);
  const rollback = new CaseRollback(cases, workspace), executions = new ExecutionStore(directory, cases);
  const record = await cases.create({ title: '执行快照虚构测试案', actor: '测试用户' });
  return { directory, cases, workspace, rollback, executions, record };
}

test('execution progress appends immutable snapshots and restores its JSON payload after store restart', async (t) => {
  const data = await fixture(t), sessionId = randomUUID();
  const payload = { messages: [{ role: 'user', text: '整理材料' }], usedModelCalls: 1, task: { status: 'running', facts: [] } };
  const first = await data.executions.save({ caseId: data.record.id, sessionId, payload, expectedRevision: 1, previousSnapshotId: null });
  assert.equal(first.caseRevision, 2); assert.equal(first.snapshot.sequence, 1); assert.equal(first.snapshot.previousId, null);
  payload.usedModelCalls = 99;
  const second = await data.executions.save({ caseId: data.record.id, sessionId, payload: { usedModelCalls: 2, status: 'waiting_input' },
    expectedRevision: first.caseRevision, previousSnapshotId: first.snapshot.id });
  assert.equal(second.caseRevision, 3); assert.equal(second.snapshot.sequence, 2); assert.equal(second.snapshot.previousId, first.snapshot.id);
  assert.equal(first.snapshot.payload.usedModelCalls, 1);
  const restarted = new ExecutionStore(data.directory);
  assert.deepEqual(await restarted.loadLatest({ caseId: data.record.id, sessionId }), second);
  assert.deepEqual(await restarted.list(data.record.id), [second]);
  const files = await readdir(join(data.cases.directory(data.record.id), 'execution', sessionId));
  assert.deepEqual(files.sort(), [`${first.snapshot.id}.json`, `${second.snapshot.id}.json`].sort());
  const state = (await data.cases.readState(data.record.id)).workspace!;
  assert.deepEqual((await validateSavedExecutionSnapshot(data.cases.directory(data.record.id), state.executionSnapshots![0]!, data.record.id, state)).payload.usedModelCalls, 1);
});

test('whole-case rollback restores execution progress and undo returns to the later snapshot', async (t) => {
  const data = await fixture(t), sessionId = randomUUID();
  const first = await data.executions.save({ caseId: data.record.id, sessionId, payload: { status: 'running', usedModelCalls: 1 }, expectedRevision: 1, previousSnapshotId: null });
  const checkpoint = await data.rollback.createCheckpoint({ caseId: data.record.id, label: '完成第一步', actor: '测试用户' });
  const beforeSecond = await data.cases.read(data.record.id);
  const second = await data.executions.save({ caseId: data.record.id, sessionId, payload: { status: 'completed', usedModelCalls: 3 }, expectedRevision: beforeSecond.revision, previousSnapshotId: first.snapshot.id });
  const preview = await data.rollback.preview({ caseId: data.record.id, checkpointId: checkpoint.id });
  assert.deepEqual(preview.executionSnapshotsLeaving, [second.snapshot.id]);
  const restored = await data.rollback.apply({ caseId: data.record.id, checkpointId: checkpoint.id, expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '测试用户' });
  const restarted = new ExecutionStore(data.directory);
  const current = await restarted.loadLatest({ caseId: data.record.id, sessionId });
  assert.deepEqual(current.snapshot, first.snapshot);
  assert.equal(current.caseRevision, restored.case.revision);
  const undo = await data.rollback.preview({ caseId: data.record.id, checkpointId: restored.undoCheckpoint.id });
  assert.deepEqual(undo.executionSnapshotsReturning, [second.snapshot.id]);
  await data.rollback.apply({ caseId: data.record.id, checkpointId: restored.undoCheckpoint.id, expectedRevision: undo.expectedRevision, previewToken: undo.token, actor: '测试用户' });
  assert.deepEqual((await new ExecutionStore(data.directory).loadLatest({ caseId: data.record.id, sessionId })).snapshot, second.snapshot);
});

test('restoring a checkpoint before session creation removes it from the current view without deleting its history file', async (t) => {
  const data = await fixture(t), sessionId = randomUUID();
  const checkpoint = await data.rollback.createCheckpoint({ caseId: data.record.id, label: '开始之前', actor: '测试用户' });
  const saved = await data.executions.save({ caseId: data.record.id, sessionId, payload: { status: 'running' }, expectedRevision: (await data.cases.read(data.record.id)).revision, previousSnapshotId: null });
  const preview = await data.rollback.preview({ caseId: data.record.id, checkpointId: checkpoint.id });
  await data.rollback.apply({ caseId: data.record.id, checkpointId: checkpoint.id, expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '测试用户' });
  await assert.rejects(data.executions.loadLatest({ caseId: data.record.id, sessionId }), code('EXECUTION_NOT_ACTIVE'));
  assert.deepEqual(await data.executions.list(data.record.id), []);
  const path = join(data.cases.directory(data.record.id), 'execution', sessionId, `${saved.snapshot.id}.json`);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).id, saved.snapshot.id);
  await assert.rejects(data.executions.save({ caseId: data.record.id, sessionId, payload: { status: 'late' }, expectedRevision: saved.caseRevision, previousSnapshotId: saved.snapshot.id }), code('EXECUTION_STALE'));
});

test('a checkpoint cannot restore modified execution snapshot bytes or a broken previous-snapshot chain', async (t) => {
  const data = await fixture(t), sessionId = randomUUID();
  const first = await data.executions.save({ caseId: data.record.id, sessionId, payload: { value: 1 }, expectedRevision: 1, previousSnapshotId: null });
  const second = await data.executions.save({ caseId: data.record.id, sessionId, payload: { value: 2 }, expectedRevision: first.caseRevision, previousSnapshotId: first.snapshot.id });
  const checkpoint = await data.rollback.createCheckpoint({ caseId: data.record.id, label: '校验快照', actor: '测试用户' });
  const path = join(data.cases.directory(data.record.id), 'execution', sessionId, `${second.snapshot.id}.json`);
  const changed = JSON.stringify({ ...second.snapshot, previousId: randomUUID() });
  await writeFile(path, changed);
  await assert.rejects(data.executions.loadLatest({ caseId: data.record.id, sessionId }), code('EXECUTION_SNAPSHOT_CHANGED'));
  await assert.rejects(data.rollback.preview({ caseId: data.record.id, checkpointId: checkpoint.id }), code('EXECUTION_SNAPSHOT_CHANGED'));
  const forged: CaseWorkspaceState = structuredClone(checkpoint.workspace);
  forged.executionSnapshots!.find((entry) => entry.snapshotId === second.snapshot.id)!.sha256 = sha(changed);
  await assert.rejects(validateSavedExecutionSnapshot(data.cases.directory(data.record.id), forged.executionSnapshots![1]!, data.record.id, forged), code('EXECUTION_SNAPSHOT_CHAIN_INVALID'));
});

test('sessions are explicitly case scoped and malformed IDs or non-JSON payloads cannot become saved progress', async (t) => {
  const data = await fixture(t), other = await data.cases.create({ title: '另一个案件', actor: '测试用户' }), sessionId = randomUUID();
  const first = await data.executions.save({ caseId: data.record.id, sessionId, payload: { usedModelCalls: 2 }, expectedRevision: 1, previousSnapshotId: null });
  await assert.rejects(data.executions.loadLatest({ caseId: other.id, sessionId }), code('EXECUTION_NOT_ACTIVE'));
  await assert.rejects(data.executions.loadLatest({ caseId: '..', sessionId }));
  await assert.rejects(data.executions.save({ caseId: data.record.id, sessionId: '../../escape', payload: {}, expectedRevision: first.caseRevision, previousSnapshotId: first.snapshot.id }));
  await assert.rejects(data.executions.save({ caseId: data.record.id, sessionId, payload: { invalid: undefined } as never, expectedRevision: first.caseRevision, previousSnapshotId: first.snapshot.id }));
  assert.equal((await data.cases.read(data.record.id)).revision, first.caseRevision);
});

test('a stale writer cannot overwrite progress and competing next snapshots publish at most one case revision', async (t) => {
  const data = await fixture(t), sessionId = randomUUID();
  const first = await data.executions.save({ caseId: data.record.id, sessionId, payload: { value: 1 }, expectedRevision: 1, previousSnapshotId: null });
  await assert.rejects(data.executions.save({ caseId: data.record.id, sessionId, payload: { value: 9 }, expectedRevision: first.caseRevision, previousSnapshotId: null }), code('EXECUTION_STALE'));
  const results = await Promise.allSettled([2, 3].map((value) => new ExecutionStore(data.directory).save({
    caseId: data.record.id, sessionId, payload: { value }, expectedRevision: first.caseRevision, previousSnapshotId: first.snapshot.id,
  })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(code('EXECUTION_STALE')(rejected.reason), true);
  const restored = await data.executions.loadLatest({ caseId: data.record.id, sessionId });
  assert.equal(restored.snapshot.sequence, 2); assert.equal(restored.caseRevision, first.caseRevision + 1);
  assert.equal((await data.cases.readState(data.record.id)).workspace!.executionSnapshots!.length, 2);
});

test('ordinary resource saves cannot remove or change execution or output references', async (t) => {
  const data = await fixture(t), sessionId = randomUUID();
  const saved = await data.executions.save({ caseId: data.record.id, sessionId, payload: {}, expectedRevision: 1, previousSnapshotId: null });
  const current = await data.cases.readState(data.record.id);
  const removal = structuredClone(current.workspace!); removal.executionSnapshots = [];
  await assert.rejects(data.cases.commitWorkspace({ caseId: data.record.id, expectedRevision: current.record.revision, workspace: removal, actor: '测试用户' }), code('CASE_RECORD_INVALID'));
  const rewrite = structuredClone(current.workspace!); rewrite.executionSnapshots![0]!.sha256 = 'a'.repeat(64);
  await assert.rejects(data.cases.commitWorkspace({ caseId: data.record.id, expectedRevision: current.record.revision, workspace: rewrite, actor: '测试用户' }), code('CASE_RECORD_INVALID'));
  const outputId = randomUUID(), withOutput = structuredClone(current.workspace!); withOutput.outputs = [{ outputId, sha256: 'b'.repeat(64) }];
  await data.cases.commitWorkspace({ caseId: data.record.id, expectedRevision: saved.caseRevision, workspace: withOutput, actor: '测试用户' });
  const removeOutput = structuredClone(withOutput); removeOutput.outputs = [];
  await assert.rejects(data.cases.commitWorkspace({ caseId: data.record.id, expectedRevision: saved.caseRevision + 1, workspace: removeOutput, actor: '测试用户' }), code('CASE_RECORD_INVALID'));
});

test('pre-cancelled saves and cancellation during journal preparation do not publish progress', async (t) => {
  const data = await fixture(t), sessionId = randomUUID(), controller = new AbortController();
  controller.abort('private cancellation reason');
  await assert.rejects(data.executions.save({ caseId: data.record.id, sessionId, payload: {}, expectedRevision: 1, previousSnapshotId: null }, { signal: controller.signal }), code('EXECUTION_CANCELLED'));
  assert.equal((await data.cases.read(data.record.id)).revision, 1);
  const late = new AbortController();
  class CancellingStore extends CaseStore {
    override async commitWorkspace(input: Parameters<CaseStore['commitWorkspace']>[0], options: Parameters<CaseStore['commitWorkspace']>[1] = {}) {
      late.abort('private cancellation reason');
      return super.commitWorkspace(input, options);
    }
  }
  await assert.rejects(new ExecutionStore(data.directory, new CancellingStore(data.directory)).save({
    caseId: data.record.id, sessionId, payload: {}, expectedRevision: 1, previousSnapshotId: null,
  }, { signal: late.signal }), code('CASE_OPERATION_CANCELLED'));
  assert.equal((await data.cases.read(data.record.id)).revision, 1);
  await assert.rejects(data.executions.loadLatest({ caseId: data.record.id, sessionId }), code('EXECUTION_NOT_ACTIVE'));
});

test('prepared write revisions fence registration, attachment import and OCR before side effects after rollback', async (t) => {
  const data = await fixture(t);
  const text = await data.workspace.registerText({ caseId: data.record.id, sourceLabel: '已有文字', text: '原始材料' });
  const prepared = await data.cases.read(data.record.id);
  const checkpoint = await data.rollback.createCheckpoint({ caseId: data.record.id, label: '执行前', actor: '测试用户' });
  const preview = await data.rollback.preview({ caseId: data.record.id, checkpointId: checkpoint.id });
  await data.rollback.apply({ caseId: data.record.id, checkpointId: checkpoint.id, expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '测试用户' });
  const before = await data.cases.readState(data.record.id);
  const options = { expectedRevision: prepared.revision };
  // Paths deliberately do not exist: revision checking must precede file reads.
  const path = join(data.directory, 'not-read-before-revision-check.png');
  await assert.rejects(data.workspace.registerText({ caseId: data.record.id, sourceLabel: '迟到文字', text: '不能进入回滚后的案件' }, options), code('CASE_REVISION_CONFLICT'));
  await assert.rejects(data.workspace.registerImage({ caseId: data.record.id, sourceLabel: '迟到图片', path }, options), code('CASE_REVISION_CONFLICT'));
  await assert.rejects(data.workspace.importFile({ caseId: data.record.id, sourceLabel: '迟到附件', path }, options), code('CASE_REVISION_CONFLICT'));
  let recognized = false;
  const ocr: OcrAdapter = { engine: { id: 'test', version: '1', languages: ['eng'] }, recognize: async () => {
    recognized = true; return { text: '不能执行', confidence: 100, lines: [] };
  }, close: async () => {} };
  await assert.rejects(data.workspace.recognize({ caseId: data.record.id, materialId: text.id }, ocr, options), code('CASE_REVISION_CONFLICT'));
  assert.equal(recognized, false);
  assert.deepEqual(await data.cases.readState(data.record.id), before);
  // Active callers can opt in without changing the existing CLI signatures.
  await data.workspace.registerText({ caseId: data.record.id, sourceLabel: '恢复后的新操作', text: '可以正常保存' }, { expectedRevision: before.record.revision });
  assert.equal((await data.cases.readState(data.record.id)).workspace!.materials.length, 2);
});
