import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { CaseError, CaseStore } from '../src/cases/store.ts';

const exec = promisify(execFile);
const actor = '测试承办人';
const slot = (revision: number) => `${String(revision).padStart(16, '0')}.json`;
async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdirTemporary();
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function mkdirTemporary(): Promise<string> {
  const directory = join(tmpdir(), `law-agent-cases-${randomUUID()}`);
  await mkdir(directory);
  return directory;
}

test('new cases persist independently, including identical titles, and reopen from a new store', async (t) => {
  const dataDir = await temporary(t);
  const store = new CaseStore(dataDir);
  assert.deepEqual(await store.list(), { cases: [], unavailable: [] });
  const first = await store.create({ title: '同名案件', actor });
  const second = await store.create({ title: '同名案件', caseNumber: '测试2026-002', description: '独立材料区域', stage: '待核对材料', actor });
  assert.notEqual(first.id, second.id);
  assert.equal(first.status, 'active');
  assert.equal(first.stage, '待整理');
  assert.equal(first.caseNumber, null);
  assert.equal(first.description, '');
  assert.equal(first.revision, 1);
  assert.notEqual(store.directory(first.id), store.directory(second.id));
  const reopened = new CaseStore(dataDir);
  assert.deepEqual(await reopened.read(first.id), first);
  assert.deepEqual(await reopened.read(second.id), second);
  assert.equal((await reopened.list()).cases.length, 2);
  assert.deepEqual(await readdir(join(store.directory(first.id), 'revisions')), [slot(1)]);
});

test('case metadata and manual progress append immutable history without changing another case', async (t) => {
  const store = new CaseStore(await temporary(t));
  const first = await store.create({ title: '甲案', caseNumber: '旧案号', actor });
  const second = await store.create({ title: '乙案', actor });
  const firstEventPath = join(store.directory(first.id), 'revisions', slot(1));
  const firstBytes = await readFile(firstEventPath);
  const paused = await store.update({ caseId: first.id, expectedRevision: 1, status: 'paused', stage: '等待补料', actor, note: '当事人正在找转账记录' });
  const closed = await store.update({ caseId: first.id, expectedRevision: 2, status: 'closed', stage: '已完成本轮办理', caseNumber: null, actor });
  const reopened = await store.update({ caseId: first.id, expectedRevision: 3, status: 'active', stage: '继续整理', title: '甲案（补充材料）', description: '补充后继续办理', actor });
  assert.equal(paused.revision, 2);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.caseNumber, null);
  assert.equal(reopened.revision, 4);
  assert.equal(reopened.createdAt, first.createdAt);
  assert.deepEqual(await readFile(firstEventPath), firstBytes);
  assert.deepEqual(await store.read(second.id), second);
  const history = await store.history(first.id);
  assert.deepEqual(history.map((event) => event.record.status), ['active', 'paused', 'closed', 'active']);
  assert.deepEqual(history.map((event) => event.revision), [1, 2, 3, 4]);
  assert.equal(history[1]!.note, '当事人正在找转账记录');
  assert.equal(history[1]!.parentId, history[0]!.id);
  assert.equal(history[3]!.record.description, '补充后继续办理');
});

test('listing searches title, number, description and stage and filters the saved status', async (t) => {
  const store = new CaseStore(await temporary(t));
  const first = await store.create({ title: '星桥案', caseNumber: 'CASE-2026-A', description: '九月工资', stage: '核对材料', actor });
  const second = await store.create({ title: '另一案件', description: '待沟通', actor });
  await store.update({ caseId: second.id, expectedRevision: 1, status: 'paused', actor });
  for (const query of ['星桥', 'case-2026-a', '九月工资', '核对材料']) {
    assert.deepEqual((await store.list({ query })).cases.map((record) => record.id), [first.id]);
  }
  assert.deepEqual((await store.list({ status: 'paused' })).cases.map((record) => record.id), [second.id]);
  assert.equal((await store.list({ query: '星桥', status: 'closed' })).cases.length, 0);
  assert.equal((await store.list({ query: '   ' })).cases.length, 2);
});

test('two independent stores cannot silently overwrite progress based on the same revision', async (t) => {
  const dataDir = await temporary(t);
  const firstStore = new CaseStore(dataDir);
  const secondStore = new CaseStore(dataDir);
  const record = await firstStore.create({ title: '并发案件', actor });
  const results = await Promise.allSettled([
    firstStore.update({ caseId: record.id, expectedRevision: 1, stage: '甲窗口进度', actor: '甲' }),
    secondStore.update({ caseId: record.id, expectedRevision: 1, stage: '乙窗口进度', actor: '乙' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected');
  assert.ok(failed && failed.status === 'rejected');
  assert.ok(failed.reason instanceof CaseError);
  assert.equal(failed.reason.code, 'CASE_REVISION_CONFLICT');
  assert.equal((await firstStore.history(record.id)).length, 2);
  assert.ok(['甲窗口进度', '乙窗口进度'].includes((await firstStore.read(record.id)).stage));
  await assert.rejects(firstStore.update({ caseId: record.id, expectedRevision: 1, title: '陈旧编辑', actor }), /CASE_REVISION_CONFLICT/);
  assert.equal((await firstStore.read(record.id)).title, record.title);
});

test('the revision slot also rejects conflicting writes from separate Node processes', async (t) => {
  const dataDir = await temporary(t);
  const store = new CaseStore(dataDir);
  const record = await store.create({ title: '跨进程案件', actor });
  const moduleUrl = new URL('../src/cases/store.ts', import.meta.url).href;
  const source = `import {CaseStore} from ${JSON.stringify(moduleUrl)};
    const [dataDir,caseId,stage] = process.argv.slice(1);
    try { const record=await new CaseStore(dataDir).update({caseId,expectedRevision:1,stage,actor:stage}); console.log(JSON.stringify({ok:true,record})); }
    catch(error) { console.log(JSON.stringify({ok:false,code:error.code,message:error.message})); }`;
  const results = await Promise.all(['进程甲', '进程乙'].map(async (label) => {
    const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', source, dataDir, record.id, label]);
    return JSON.parse(stdout) as { ok: boolean; code?: string };
  }));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.find((result) => !result.ok)?.code, 'CASE_REVISION_CONFLICT');
  assert.equal((await store.history(record.id)).length, 2);
});

test('one broken case is reported separately while other cases remain listable', async (t) => {
  const store = new CaseStore(await temporary(t));
  const healthy = await store.create({ title: '正常案件', actor });
  const broken = await store.create({ title: '损坏案件', actor });
  await writeFile(join(store.directory(broken.id), 'revisions', slot(1)), 'broken json');
  const list = await store.list();
  assert.deepEqual(list.cases.map((record) => record.id), [healthy.id]);
  assert.deepEqual(list.unavailable.map((entry) => entry.caseId), [broken.id]);
  assert.match(list.unavailable[0]!.reason, /CASE_RECORD_INVALID/);
  assert.deepEqual(await store.read(healthy.id), healthy);
});

test('incomplete creates and temporary records are not advertised as saved cases', async (t) => {
  const store = new CaseStore(await temporary(t));
  await store.initialize();
  const orphanId = randomUUID();
  const directory = join(store.directory(orphanId), 'revisions');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${randomUUID()}.tmp`), 'uncommitted');
  assert.deepEqual(await store.list(), { cases: [], unavailable: [] });
  await assert.rejects(store.read(orphanId), /CASE_NOT_FOUND/);
});

test('case IDs cannot escape their workspace and invalid updates never create new history', async (t) => {
  const store = new CaseStore(await temporary(t));
  assert.throws(() => store.directory('../outside'));
  await assert.rejects(store.read('../outside'));
  await assert.rejects(store.read(randomUUID()), /CASE_NOT_FOUND/);
  const record = await store.create({ title: '原始案件', actor });
  await assert.rejects(store.update({ caseId: record.id, expectedRevision: 1, actor }));
  await assert.rejects(store.update({ caseId: record.id, expectedRevision: 1, actor, stage: ' ' }));
  assert.equal((await store.history(record.id)).length, 1);
});

test('history validates identity, revision slots, parents, timestamps and initial state', async (t) => {
  const dataDir = await temporary(t);
  const store = new CaseStore(dataDir);
  const mutations = [
    { name: 'case identity', mutate: (event: any) => { event.caseId = randomUUID(); } },
    { name: 'record identity', mutate: (event: any) => { event.record.id = randomUUID(); } },
    { name: 'event revision', mutate: (event: any) => { event.revision = 3; } },
    { name: 'parent identity', mutate: (event: any) => { event.parentId = randomUUID(); } },
    { name: 'creation date', mutate: (event: any) => { event.record.createdAt = '2020-01-01T00:00:00.000Z'; } },
    { name: 'timestamp agreement', mutate: (event: any) => { event.record.updatedAt = '2020-01-01T00:00:00.000Z'; } },
    { name: 'updated kind', mutate: (event: any) => { event.kind = 'created'; } },
  ];
  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const record = await store.create({ title: mutation.name, actor });
      await store.update({ caseId: record.id, expectedRevision: 1, stage: '新进度', actor });
      const path = join(store.directory(record.id), 'revisions', slot(2));
      const event = JSON.parse(await readFile(path, 'utf8'));
      mutation.mutate(event);
      await writeFile(path, JSON.stringify(event));
      await assert.rejects(store.read(record.id), /CASE_RECORD_INVALID/);
    });
  }
  const initial = await store.create({ title: '初始状态', actor });
  const path = join(store.directory(initial.id), 'revisions', slot(1));
  const event = JSON.parse(await readFile(path, 'utf8'));
  event.record.status = 'closed';
  await writeFile(path, JSON.stringify(event));
  await assert.rejects(store.read(initial.id), /CASE_RECORD_INVALID/);
  const gap = await store.create({ title: '序号缺口', actor });
  const first = await readFile(join(store.directory(gap.id), 'revisions', slot(1)));
  await writeFile(join(store.directory(gap.id), 'revisions', slot(3)), first);
  await assert.rejects(store.read(gap.id), /CASE_RECORD_INVALID/);
});
