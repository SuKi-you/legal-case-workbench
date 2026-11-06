import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MaterialStore, MaterialTextStore, sourceReferenceSchema, textVersionSchema, resolvedReferenceSchema } from '../src/index.ts';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../examples/material-text.ts', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
async function run(args: string[]): Promise<unknown> {
  const { stdout } = await exec(process.execPath, [cli, ...args], { cwd: root });
  return JSON.parse(stdout);
}
async function setup(t: TestContext, text = '😀 模拟工资8000元。') {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-edit-cli-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const dataDir = join(directory, 'data');
  const store = new MaterialStore(dataDir);
  const material = await store.registerText({ groupId: 'cli-test', sourceLabel: '虚构文本', text });
  return { directory, dataDir, store, material, file: join(directory, 'editable.txt') };
}

test('real CLI exports editable text, saves direct file edits, and advances only the draft base', async (t) => {
  const { dataDir, store, material, file } = await setup(t);
  await run(['export', '--data-dir', dataDir, '--material', material.id, '--version', material.id, '--file', file]);
  assert.equal(await readFile(file, 'utf8'), '😀 模拟工资8000元。');
  await writeFile(file, '😀 模拟工资6000元。', 'utf8');
  const first = textVersionSchema.parse(await run(['save', '--file', file, '--editor', '测试编辑者']));
  assert.equal(first.kind, 'revision');
  assert.equal(first.text, '😀 模拟工资6000元。');
  if (first.kind === 'revision') assert.equal(first.baseVersionId, material.id);
  await writeFile(file, '😀 模拟工资7000元。', 'utf8');
  const second = textVersionSchema.parse(await run(['save', '--file', file, '--editor', '测试编辑者']));
  assert.equal(second.kind, 'revision');
  if (second.kind === 'revision') assert.equal(second.baseVersionId, first.id);
  assert.equal((await store.read(material.id)).text, '😀 模拟工资8000元。');
  assert.equal((await new MaterialTextStore(dataDir).listVersions(material.id)).length, 3);
});

test('CLI requires an explicit occurrence for repeated quotes and resolves its persisted reference', async (t) => {
  const text = '😀 6000元，另一处6000元。';
  const { dataDir, material } = await setup(t, text);
  const args = ['cite', '--data-dir', dataDir, '--material', material.id, '--version', material.id, '--quote', '6000元'];
  await assert.rejects(run(args), /摘录出现多次/);
  const start = text.lastIndexOf('6000元');
  const reference = sourceReferenceSchema.parse(await run([...args, '--start', String(start)]));
  assert.equal(reference.start, start);
  const resolved = resolvedReferenceSchema.parse(await run([
    'resolve', '--data-dir', dataDir, '--material', material.id, '--reference', reference.id,
  ]));
  assert.equal(resolved.version.id, material.id);
  assert.equal(resolved.reference.quote, '6000元');
});

test('CLI does not overwrite existing drafts, edit managed originals, or silently decode invalid UTF-8', async (t) => {
  const { dataDir, store, material, file } = await setup(t);
  const args = ['export', '--data-dir', dataDir, '--material', material.id, '--version', material.id, '--file'];
  await writeFile(file, '用户已有文件');
  await assert.rejects(run([...args, file]), /EEXIST/);
  assert.equal(await readFile(file, 'utf8'), '用户已有文件');
  await assert.rejects(readFile(`${file}.meta.json`), /ENOENT/);
  const original = (await store.read(material.id)).originalPath;
  await assert.rejects(run([...args, original]), /原件目录以外/);
  const secondFile = `${file}.new.txt`;
  await run([...args, secondFile]);
  await writeFile(secondFile, Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(run(['save', '--file', secondFile, '--editor', '测试编辑者']), /encoding utf-8/);
  assert.equal((await new MaterialTextStore(dataDir).listVersions(material.id)).length, 1);
});

test('CLI export rejects a directory junction alias into managed material storage', async (t) => {
  const { directory, dataDir, material } = await setup(t);
  const alias = join(directory, 'looks-like-drafts');
  await symlink(join(dataDir, 'materials'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run([
    'export', '--data-dir', dataDir, '--material', material.id, '--version', material.id,
    '--file', join(alias, material.id, 'should-not-be-created.txt'),
  ]), /原件目录以外/);
});
