import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CaseStore } from '../src/cases/store.ts';
import type { CaseEvent, CaseWorkspaceState } from '../src/cases/contracts.ts';

const actor = '虚构测试用户';
const hash = (letter = 'a') => letter.repeat(64);
const slot = (revision: number) => `${String(revision).padStart(16, '0')}.json`;
const clone = <T>(value: T): T => structuredClone(value);
function resources(): CaseWorkspaceState {
  return {
    materials: [{ materialId: randomUUID(), originalSha256: hash(), ocrAttemptIds: [randomUUID()],
      versions: [{ versionId: randomUUID(), textSha256: hash('b') }], referenceIds: [randomUUID()] }],
    files: [{ fileId: randomUUID(), sha256: hash('c') }],
  };
}
async function setup(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-case-journal-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const store = new CaseStore(dataDir);
  const record = await store.create({ title: '虚构案件', caseNumber: 'TEST-001', actor });
  const eventPath = (revision: number) => join(store.directory(record.id), 'revisions', slot(revision));
  return { dataDir, store, record, eventPath };
}

test('resource commits share case revisions and metadata updates preserve the committed inventory', async (t) => {
  const { store, record } = await setup(t);
  assert.deepEqual((await store.readState(record.id)).workspace, { materials: [], files: [] });
  const workspace = resources();
  const committed = await store.commitWorkspace({ caseId: record.id, expectedRevision: 1, workspace, actor });
  assert.equal(committed.revision, 2);
  assert.equal(committed.title, record.title);
  const updated = await store.update({ caseId: record.id, expectedRevision: 2, actor, title: '已更新案件名', stage: '核对中' });
  assert.equal(updated.revision, 3);
  assert.deepEqual((await store.readState(record.id)).workspace, workspace);
  assert.deepEqual((await store.history(record.id)).map((event) => event.kind), ['created', 'workspace_updated', 'updated']);
  await assert.rejects(store.commitWorkspace({ caseId: record.id, expectedRevision: 2, workspace, actor }), /CASE_REVISION_CONFLICT/);
});

test('a single rollback event restores complete state and publishes a usable automatic undo checkpoint', async (t) => {
  const { dataDir, store, record, eventPath } = await setup(t);
  const original = resources();
  await store.commitWorkspace({ caseId: record.id, expectedRevision: 1, workspace: original, actor });
  const checkpoint = await store.createCheckpoint({ caseId: record.id, expectedRevision: 2, label: '首份材料', actor });
  assert.equal(checkpoint.sourceRevision, 2);
  assert.equal(checkpoint.automatic, false);
  assert.equal((await store.read(record.id)).revision, 3);
  const changed = await store.update({ caseId: record.id, expectedRevision: 3, actor, title: '后续名称', status: 'paused', stage: '待补料' });
  const expanded = clone(original);
  expanded.materials[0]!.versions.push({ versionId: randomUUID(), textSha256: hash('d') });
  expanded.materials[0]!.referenceIds.push(randomUUID());
  expanded.materials.push(...resources().materials);
  expanded.files.push(...resources().files);
  await store.commitWorkspace({ caseId: record.id, expectedRevision: changed.revision, workspace: expanded, actor });
  const before = await store.readState(record.id);
  const previousBytes = await Promise.all([1, 2, 3, 4, 5].map((revision) => readFile(eventPath(revision))));
  const result = await store.restoreCheckpoint({ caseId: record.id, checkpointId: checkpoint.id, expectedRevision: 5, actor, note: '恢复保存点' });
  assert.equal(result.case.revision, 6);
  assert.equal(result.case.title, record.title);
  assert.equal(result.case.status, 'active');
  assert.equal(result.case.createdAt, record.createdAt);
  assert.deepEqual((await store.readState(record.id)).workspace, original);
  assert.equal(result.undoCheckpoint.automatic, true);
  assert.deepEqual(result.undoCheckpoint.record, before.record);
  assert.deepEqual(result.undoCheckpoint.workspace, expanded);
  assert.deepEqual(await store.getCheckpoint({ caseId: record.id, checkpointId: result.undoCheckpoint.id }), result.undoCheckpoint);
  assert.equal((await store.listCheckpoints(record.id)).length, 2);
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map((revision) => readFile(eventPath(revision)))), previousBytes);
  const resumed = new CaseStore(dataDir);
  const undone = await resumed.restoreCheckpoint({ caseId: record.id, checkpointId: result.undoCheckpoint.id, expectedRevision: 6, actor });
  assert.equal(undone.case.revision, 7);
  assert.equal(undone.case.title, before.record.title);
  assert.equal(undone.case.status, 'paused');
  assert.deepEqual((await resumed.readState(record.id)).workspace, expanded);
  assert.equal((await resumed.listCheckpoints(record.id)).length, 3);
  assert.equal((await resumed.history(record.id))[5]!.undoCheckpoint?.id, result.undoCheckpoint.id);
});

test('concurrent resource and profile updates cannot both claim the same case revision', async (t) => {
  const { dataDir, store, record } = await setup(t);
  const other = new CaseStore(dataDir);
  const results = await Promise.allSettled([
    store.commitWorkspace({ caseId: record.id, expectedRevision: 1, workspace: resources(), actor }),
    other.update({ caseId: record.id, expectedRevision: 1, stage: '另一个窗口', actor }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.match(String(rejected.reason), /CASE_REVISION_CONFLICT/);
  assert.equal((await store.history(record.id)).length, 2);
});

test('legacy profile-only histories remain readable and can initialize their inventory once', async (t) => {
  const { dataDir, store, record, eventPath } = await setup(t);
  const initial = JSON.parse(await readFile(eventPath(1), 'utf8')) as CaseEvent;
  delete initial.workspace;
  await writeFile(eventPath(1), JSON.stringify(initial));
  const resumed = new CaseStore(dataDir);
  assert.equal((await resumed.readState(record.id)).workspace, undefined);
  await resumed.update({ caseId: record.id, expectedRevision: 1, stage: '旧案件继续办理', actor });
  await assert.rejects(resumed.createCheckpoint({ caseId: record.id, expectedRevision: 2, label: '尚未初始化', actor }), /CASE_WORKSPACE_UNINITIALIZED/);
  const workspace = resources();
  await resumed.commitWorkspace({ caseId: record.id, expectedRevision: 2, workspace, actor });
  assert.equal((await resumed.history(record.id))[2]!.kind, 'workspace_initialized');
  assert.deepEqual((await resumed.readState(record.id)).workspace, workspace);
  const checkpoint = await resumed.createCheckpoint({ caseId: record.id, expectedRevision: 3, label: '已接管旧材料', actor });
  assert.deepEqual(checkpoint.workspace, workspace);
  assert.equal((await store.history(record.id)).length, 4);
});

test('ordinary resource commits cannot remove, rewrite or duplicate inventory entries', async (t) => {
  const { store, record, eventPath } = await setup(t);
  const original = resources();
  await store.commitWorkspace({ caseId: record.id, expectedRevision: 1, workspace: original, actor });
  const badStates: CaseWorkspaceState[] = [];
  const removed = clone(original); removed.materials = []; badStates.push(removed);
  const originalHash = clone(original); originalHash.materials[0]!.originalSha256 = hash('e'); badStates.push(originalHash);
  const versionHash = clone(original); versionHash.materials[0]!.versions[0]!.textSha256 = hash('e'); badStates.push(versionHash);
  const removedVersion = clone(original); removedVersion.materials[0]!.versions = []; badStates.push(removedVersion);
  const removedOcr = clone(original); removedOcr.materials[0]!.ocrAttemptIds = []; badStates.push(removedOcr);
  const removedRef = clone(original); removedRef.materials[0]!.referenceIds = []; badStates.push(removedRef);
  const removedFile = clone(original); removedFile.files = []; badStates.push(removedFile);
  const fileHash = clone(original); fileHash.files[0]!.sha256 = hash('f'); badStates.push(fileHash);
  const duplicate = clone(original); duplicate.materials.push(clone(duplicate.materials[0]!)); badStates.push(duplicate);
  const duplicateVersion = clone(original); duplicateVersion.materials[0]!.versions.push(clone(duplicateVersion.materials[0]!.versions[0]!)); badStates.push(duplicateVersion);
  const duplicateRef = clone(original); duplicateRef.materials[0]!.referenceIds.push(duplicateRef.materials[0]!.referenceIds[0]!); badStates.push(duplicateRef);
  const duplicateFile = clone(original); duplicateFile.files.push(clone(duplicateFile.files[0]!)); badStates.push(duplicateFile);
  for (const workspace of badStates) {
    await assert.rejects(store.commitWorkspace({ caseId: record.id, expectedRevision: 2, workspace, actor }), /CASE_RECORD_INVALID/);
  }
  assert.deepEqual((await store.readState(record.id)).workspace, original);
  await assert.rejects(readFile(eventPath(3)), /ENOENT/);
});

test('checkpoints cannot be borrowed from another case and stale saves add no history', async (t) => {
  const { store, record } = await setup(t);
  const other = await store.create({ title: '另一案件', actor });
  const checkpoint = await store.createCheckpoint({ caseId: record.id, expectedRevision: 1, label: '第一案保存点', actor });
  await assert.rejects(store.getCheckpoint({ caseId: other.id, checkpointId: checkpoint.id }), /CASE_CHECKPOINT_NOT_FOUND/);
  await assert.rejects(store.restoreCheckpoint({ caseId: other.id, checkpointId: checkpoint.id, expectedRevision: 1, actor }), /CASE_CHECKPOINT_NOT_FOUND/);
  await assert.rejects(store.createCheckpoint({ caseId: record.id, expectedRevision: 1, label: '陈旧保存点', actor }), /CASE_REVISION_CONFLICT/);
  await assert.rejects(store.restoreCheckpoint({ caseId: record.id, checkpointId: checkpoint.id, expectedRevision: 1, actor }), /CASE_REVISION_CONFLICT/);
  assert.equal((await store.history(record.id)).length, 2);
  assert.equal((await store.history(other.id)).length, 1);
});

test('history rejects resource and checkpoint tampering rather than silently restoring false state', async (t) => {
  const modifications: { name: string; at: number; mutate(event: CaseEvent): void }[] = [
    { name: 'resource commit edits profile', at: 2, mutate(event) { event.record.title = '伪造名称'; } },
    { name: 'double initialization', at: 2, mutate(event) { event.kind = 'workspace_initialized'; } },
    { name: 'profile changes resources', at: 4, mutate(event) { event.workspace!.files = []; } },
    { name: 'checkpoint record', at: 3, mutate(event) { event.checkpoint!.record.title = '伪造快照'; } },
    { name: 'checkpoint source revision', at: 3, mutate(event) { event.checkpoint!.sourceRevision = 1; } },
    { name: 'checkpoint actor', at: 3, mutate(event) { event.checkpoint!.actor = '伪造操作者'; } },
    { name: 'checkpoint automatic flag', at: 3, mutate(event) { event.checkpoint!.automatic = true; } },
    { name: 'rollback source', at: 5, mutate(event) { event.restoredCheckpointId = randomUUID(); } },
    { name: 'rollback profile', at: 5, mutate(event) { event.record.stage = '错误的恢复阶段'; } },
    { name: 'rollback workspace', at: 5, mutate(event) { event.workspace!.materials = []; } },
    { name: 'undo snapshot', at: 5, mutate(event) { event.undoCheckpoint!.record.title = '错误的撤销状态'; } },
    { name: 'undo identity', at: 5, mutate(event) { event.undoCheckpoint!.id = event.restoredCheckpointId!; } },
  ];
  for (const modification of modifications) await t.test(modification.name, async (child) => {
    const { store, record, eventPath } = await setup(child);
    await store.commitWorkspace({ caseId: record.id, expectedRevision: 1, workspace: resources(), actor });
    const checkpoint = await store.createCheckpoint({ caseId: record.id, expectedRevision: 2, label: '测试保存点', actor });
    await store.update({ caseId: record.id, expectedRevision: 3, stage: '新的阶段', actor });
    await store.restoreCheckpoint({ caseId: record.id, checkpointId: checkpoint.id, expectedRevision: 4, actor });
    const event = JSON.parse(await readFile(eventPath(modification.at), 'utf8')) as CaseEvent;
    modification.mutate(event);
    await writeFile(eventPath(modification.at), JSON.stringify(event));
    await assert.rejects(store.history(record.id), /CASE_RECORD_INVALID/);
  });
});

test('journal commits publish complete records and keep no temporary files after successful rollback', async (t) => {
  const { store, record } = await setup(t);
  const checkpoint = await store.createCheckpoint({ caseId: record.id, expectedRevision: 1, label: '空案件保存点', actor });
  await store.restoreCheckpoint({ caseId: record.id, checkpointId: checkpoint.id, expectedRevision: 2, actor });
  assert.deepEqual(await readdir(join(store.directory(record.id), 'revisions')), [slot(1), slot(2), slot(3)]);
  const history = await store.history(record.id);
  assert.equal(history[2]!.kind, 'rolled_back');
  assert.ok(history[2]!.undoCheckpoint);
});
