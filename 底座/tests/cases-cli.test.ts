import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  caseCheckpointSchema, caseCheckpointsSchema, caseContentsSchema, caseHistorySchema, caseListSchema, caseRecordSchema, materialSchema,
  rollbackPreviewSchema, rollbackResultSchema,
  storedCaseFileSchema, textVersionSchema, textVersionsSchema,
} from '../src/index.ts';

const exec = promisify(execFile);
const caseCli = fileURLToPath(new URL('../examples/cases.ts', import.meta.url));
const textCli = fileURLToPath(new URL('../examples/material-text.ts', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
async function run(cli: string, args: string[]): Promise<unknown> {
  const { stdout } = await exec(process.execPath, [cli, ...args], { cwd: root });
  return JSON.parse(stdout);
}
async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-cases-cli-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('case CLI creates separate projects, marks progress, and restores each case across command processes', async (t) => {
  const directory = await temporary(t);
  const dataDir = join(directory, 'data');
  const call = (args: string[]) => run(caseCli, [...args, '--data-dir', dataDir]);
  const a = caseRecordSchema.parse(await call(['create', '--title', '虚构项目A', '--number', 'A-001']));
  const b = caseRecordSchema.parse(await call(['create', '--title', '虚构项目B']));
  const material = materialSchema.parse(await call(['add-text', '--case', a.id, '--text', '仅在A案保存的记录。']));
  await call(['add-text', '--case', b.id, '--text', '仅在B案保存的记录。']);
  const beforeMark = caseContentsSchema.parse(await call(['open', '--case', a.id])).case;
  assert.equal(beforeMark.revision, a.revision + 1);
  const marked = caseRecordSchema.parse(await call([
    'mark', '--case', a.id, '--stage', '已核对材料', '--status', 'paused', '--expected-revision', String(beforeMark.revision), '--actor', '测试律师',
  ]));
  assert.equal(marked.stage, '已核对材料');
  assert.equal(marked.revision, beforeMark.revision + 1);
  const list = caseListSchema.parse(await call(['list', '--query', 'A-001', '--status', 'paused']));
  assert.deepEqual(list.cases.map((item) => item.id), [a.id]);
  const opened = caseContentsSchema.parse(await call(['open', '--case', a.id.toUpperCase()]));
  assert.deepEqual(opened.materials.map((item) => item.id), [material.id]);
  const history = caseHistorySchema.parse(await call(['history', '--case', a.id]));
  assert.equal(history.length, marked.revision);
  assert.deepEqual(history.map((event) => event.kind), ['created', 'workspace_updated', 'updated']);
  await assert.rejects(call(['read-material', '--case', b.id, '--material', material.id]), /MATERIAL_NOT_FOUND/);
  await assert.rejects(call([
    'mark', '--case', a.id, '--stage', '过期修改', '--expected-revision', String(beforeMark.revision),
  ]), /CASE_REVISION_CONFLICT/);
});

test('case CLI stores opaque documents and scoped editable drafts never fall back to another case', async (t) => {
  const directory = await temporary(t);
  const dataDir = join(directory, 'data');
  const call = (args: string[]) => run(caseCli, [...args, '--data-dir', dataDir]);
  const a = caseRecordSchema.parse(await call(['create', '--title', '附件与修订A']));
  const b = caseRecordSchema.parse(await call(['create', '--title', '附件与修订B']));
  const upload = join(directory, 'unparsed.pdf');
  const bytes = Buffer.from('%PDF-1.7\nFictional opaque bytes; no PDF parsing is performed.\n');
  await writeFile(upload, bytes);
  const file = storedCaseFileSchema.parse(await call(['add-file', '--case', a.id, '--path', upload]));
  const destination = join(directory, 'exports', 'original.pdf');
  await call(['take-file', '--case', a.id, '--file-id', file.id, '--out', destination]);
  assert.deepEqual(await readFile(destination), bytes);
  await assert.rejects(call(['take-file', '--case', b.id, '--file-id', file.id, '--out', `${destination}.other`]), /FILE_NOT_FOUND/);
  await assert.rejects(call(['take-file', '--case', a.id, '--file-id', file.id, '--out', destination]), /EEXIST|EXISTS/);
  const material = materialSchema.parse(await call(['add-text', '--case', a.id, '--text', '模拟金额8000元。']));
  const editable = join(directory, 'draft.txt');
  await run(textCli, ['export', '--data-dir', dataDir, '--case', a.id,
    '--material', material.id, '--version', material.id, '--file', editable]);
  await writeFile(editable, '模拟金额6000元。');
  await assert.rejects(run(textCli, ['save', '--file', editable, '--case', b.id, '--editor', '测试律师']), /另一案件/);
  const revision = textVersionSchema.parse(await run(textCli, ['save', '--file', editable, '--editor', '测试律师']));
  assert.equal(revision.text, '模拟金额6000元。');
  const versions = textVersionsSchema.parse(await run(textCli, ['versions', '--data-dir', dataDir, '--case', a.id, '--material', material.id]));
  assert.equal(versions.length, 2);
  await assert.rejects(run(textCli, ['versions', '--data-dir', dataDir, '--case', b.id, '--material', material.id]), /MATERIAL_NOT_FOUND/);
});

test('case CLI previews a whole-case restore, rejects outdated previews and restores its automatic undo point', async (t) => {
  const dataDir = join(await temporary(t), 'data');
  const call = (args: string[]) => run(caseCli, [...args, '--data-dir', dataDir]);
  const record = caseRecordSchema.parse(await call(['create', '--title', '虚构回滚CLI案', '--stage', '接案登记']));
  const original = materialSchema.parse(await call(['add-text', '--case', record.id, '--text', '最初保存的材料']));
  const checkpoint = caseCheckpointSchema.parse(await call(['checkpoint', '--case', record.id, '--label', '初次登记完成']));
  await call(['add-text', '--case', record.id, '--text', '保存点后补充的材料']);
  await call(['mark', '--case', record.id, '--stage', '材料核对完成', '--status', 'paused']);
  const previewArgs = ['rollback-preview', '--case', record.id, '--checkpoint', checkpoint.id];
  const stale = rollbackPreviewSchema.parse(await call(previewArgs));
  await call(['add-text', '--case', record.id, '--text', '预览后另一窗口保存的材料']);
  const rollbackArgs = (id: string, revision: number, token: string) => ['rollback', '--case', record.id,
    '--checkpoint', id, '--expected-revision', String(revision), '--preview-token', token];
  await assert.rejects(call(rollbackArgs(checkpoint.id, stale.expectedRevision, stale.token)), /CASE_ROLLBACK_STALE/);
  await assert.rejects(call(['rollback', '--case', record.id, '--checkpoint', checkpoint.id,
    '--expected-revision', String(stale.expectedRevision)]), /preview-token/);
  const preview = rollbackPreviewSchema.parse(await call(previewArgs));
  assert.equal(preview.materialsLeaving.length, 2);
  const result = rollbackResultSchema.parse(await call(rollbackArgs(checkpoint.id, preview.expectedRevision, preview.token)));
  const restored = caseContentsSchema.parse(await call(['open', '--case', record.id]));
  assert.deepEqual(restored.materials.map((material) => material.id), [original.id]);
  assert.equal(restored.case.stage, '接案登记');
  assert.equal(restored.case.status, 'active');
  const checkpoints = caseCheckpointsSchema.parse(await call(['checkpoints', '--case', record.id]));
  assert.deepEqual(checkpoints.map((item) => item.id), [checkpoint.id, result.undoCheckpoint.id]);
  assert.equal(checkpoints[1]?.automatic, true);
  const undo = rollbackPreviewSchema.parse(await call(['rollback-preview', '--case', record.id, '--checkpoint', result.undoCheckpoint.id]));
  await call(rollbackArgs(result.undoCheckpoint.id, undo.expectedRevision, undo.token));
  const undone = caseContentsSchema.parse(await call(['open', '--case', record.id]));
  assert.equal(undone.materials.length, 3);
  assert.equal(undone.case.stage, '材料核对完成');
  assert.equal(undone.case.status, 'paused');
  assert.equal(caseHistorySchema.parse(await call(['history', '--case', record.id])).filter((event) => event.kind === 'rolled_back').length, 2);
});
