import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import { createOutputFixture, outputFixtureTexts } from '../examples/output-fixtures.ts';
import { createCaseOutput, readCaseOutput, listCaseOutputs, exportCaseOutput } from '../src/outputs/store.ts';
import { CaseRollback } from '../src/cases/rollback.ts';
import { organizeCaseInformation } from '../src/information/service.ts';
import { CaseStore } from '../src/cases/store.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-outputs-'));
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  return { directory, ...await createOutputFixture(directory) };
}
function zipXml(bytes: Buffer, name: string): string {
  // Read the standard ZIP central directory rather than assuming compression or entry ordering.
  for (let position = 0; position <= bytes.length - 46; position += 1) {
    if (bytes.readUInt32LE(position) !== 0x02014b50) continue;
    const length = bytes.readUInt16LE(position + 28), extra = bytes.readUInt16LE(position + 30), comment = bytes.readUInt16LE(position + 32);
    const path = bytes.subarray(position + 46, position + 46 + length).toString('utf8');
    if (path === name) {
      const offset = bytes.readUInt32LE(position + 42), method = bytes.readUInt16LE(position + 10), size = bytes.readUInt32LE(position + 20);
      assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
      const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
      const data = bytes.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    position += 45 + length + extra + comment;
  }
  assert.fail(`Missing ZIP entry ${name}`);
}

test('outputs build a source-backed draft, honest uncertain timeline, conflict pairs and real editable Word file', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run.status, 'needs_review');
  const manifest = await createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id });
  const output = await readCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId: manifest.outputId });
  assert.equal(output.currentInputMatches, true);
  assert.deepEqual(output.draft.findings, f.run.findings);
  assert.equal(output.draft.timeline.length, 2);
  assert.equal(output.draft.uncertainTimeFindingIds.length, 1);
  assert.equal(output.draft.analysis!.conflicts.filter((item) => item.classification === 'inconsistent').length, 1);
  assert.match(output.markdown, /可比记载不一致/u);
  assert.match(output.markdown, /6000 CNY/u); assert.match(output.markdown, /8000 CNY/u);
  assert.match(output.markdown, /日期未明或只有相对时间/u);
  assert.equal(output.draft.findings.find((item) => item.record?.time.raw === '上周')!.record!.time.start, null);
  assert.match(output.markdown, /UTF-16/u); assert.match(output.markdown, new RegExp(f.selections[0]!.versionId));
  const xml = zipXml(await readFile(output.paths.docx), 'word/document.xml');
  assert.match(xml, /甲与乙材料核对示例 接案材料整理底稿/u);
  assert.match(xml, /6000 CNY/u); assert.match(xml, /8000 CNY/u); assert.match(xml, /上周/u);
  assert.match(xml, /\[R1\]/u); assert.match(xml, /来源摘录与固定版本定位/u);
  assert.match(zipXml(await readFile(output.paths.docx), 'word/styles.xml'), /宋体/u);
  assert.equal((await listCaseOutputs({ dataDir: f.directory, caseId: f.record.id })).length, 1);
  const reopened = await readCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId: manifest.outputId });
  assert.deepEqual(reopened.manifest, manifest);
});

test('an output operation ID is idempotent and cannot be reused for different plugin content', async (t) => {
  const f = await fixture(t), outputId = randomUUID();
  const input = { dataDir: f.directory, caseId: f.record.id, runId: f.run.id, outputId };
  const first = await createCaseOutput(input), revision = (await f.cases.read(f.record.id)).revision;
  assert.deepEqual(await createCaseOutput(input), first);
  assert.equal((await f.cases.read(f.record.id)).revision, revision);
  await assert.rejects(createCaseOutput({ ...input, sections: [{ id: 'different', title: '其他贡献', provider: { id: 'test', version: '1' },
    paragraphs: [{ text: '这是另一份输出请求', findingIds: [f.run.findings[0]!.id] }] }] }), /OUTPUT_ID_CONFLICT/);
});

test('creating another source reference does not make unchanged case inputs appear stale', async (t) => {
  const f = await fixture(t);
  const manifest = await createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id });
  const source = f.run.findings[0]!.citations[0]!;
  await f.workspace.createReference({ caseId: f.record.id, materialId: source.materialId, versionId: source.versionId,
    start: source.start, end: source.end, quote: source.quote });
  assert.equal((await readCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId: manifest.outputId })).currentInputMatches, true);
});

test('plugin sections retain provenance and citations, reject foreign findings, duplicate IDs and malformed table rows', async (t) => {
  const f = await fixture(t), findingId = f.run.findings[0]!.id;
  const valid = { id: 'test.contribution', title: '核查建议', provider: { id: 'test.domain-plugin', version: '1.2.0' },
    paragraphs: [{ text: '请对照双方金额记载核对原件。', findingIds: [findingId] }],
    tables: [{ title: '逐项复核', columns: ['事项', '建议'], rows: [{ cells: ['付款金额', '保留双方说法'], findingIds: [findingId] }] }] };
  const base = { dataDir: f.directory, caseId: f.record.id, runId: f.run.id };
  const output = await createCaseOutput({ ...base, sections: [valid] });
  const read = await readCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId: output.outputId });
  assert.match(read.markdown, /test\.domain-plugin/u); assert.match(read.markdown, /需承办人复核/u);
  const before = (await f.cases.read(f.record.id)).revision;
  await assert.rejects(createCaseOutput({ ...base, sections: [{ ...valid, paragraphs: [{ text: '别案信息', findingIds: [randomUUID()] }] }] }), /OUTPUT_SECTION_INVALID/);
  await assert.rejects(createCaseOutput({ ...base, sections: [valid, valid] }), /OUTPUT_SECTION_INVALID/);
  await assert.rejects(createCaseOutput({ ...base, sections: [{ ...valid, tables: [{ title: '错误列数', columns: ['一', '二'], rows: [{ cells: ['只有一列'], findingIds: [findingId] }] }] }] }), /OUTPUT_SECTION_INVALID/);
  assert.equal((await f.cases.read(f.record.id)).revision, before);
});

test('outputs remain immutable through supplement and text correction, with new-version differences and stale markers', async (t) => {
  const f = await fixture(t);
  const first = await createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id });
  const original = await readCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId: first.outputId });
  const selection = f.selections[1]!;
  const view = await f.workspace.readVersion({ caseId: f.record.id, ...selection });
  const revision = await f.workspace.saveRevision({ caseId: f.record.id, materialId: selection.materialId,
    baseVersionId: selection.versionId, baseTextSha256: view.version.textSha256,
    text: outputFixtureTexts[1].replace('8000', '6000'), editor: '虚构核对员' });
  assert.equal((await readCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId: first.outputId })).currentInputMatches, false);
  const selections = f.selections.map((item) => item.materialId === selection.materialId ? { ...item, versionId: revision.id } : item);
  const run = await organizeCaseInformation({ dataDir: f.directory, caseId: f.record.id, model: f.model,
    plan: { goal: f.run.goal, needs: f.needs, selections, limits: { maxRounds: 4, maxReads: 12 } } });
  const second = await createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: run.id, previousOutputId: first.outputId });
  const latest = await readCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId: second.outputId });
  assert.equal(latest.draft.changes!.addedStatements.length, 1);
  assert.equal(latest.draft.changes!.removedStatements.length, 1);
  assert.equal(latest.draft.changes!.removedConflicts.length, 1);
  assert.match(latest.markdown, /不将未再列出的差异自动认定为事实已解决/u);
  assert.equal(latest.currentInputMatches, true);
  assert.equal((await readFile(original.paths.md, 'utf8')), original.markdown);
  assert.equal((await listCaseOutputs({ dataDir: f.directory, caseId: f.record.id })).length, 2);
});

test('whole-case rollback removes new output from the active view, preserves exported copies, and undo restores it', async (t) => {
  const f = await fixture(t), rollback = new CaseRollback(f.cases, f.workspace);
  const checkpoint = await rollback.createCheckpoint({ caseId: f.record.id, label: '生成底稿之前', actor: '测试' });
  const outputId = randomUUID(), manifest = await createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id, outputId });
  const copy = await exportCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId, format: 'docx', destination: join(f.directory, 'exports', '外部副本.docx') });
  const bytes = await readFile(copy.destination);
  const preview = await rollback.preview({ caseId: f.record.id, checkpointId: checkpoint.id });
  assert.deepEqual(preview.outputsLeaving, [outputId]);
  const restored = await rollback.apply({ caseId: f.record.id, checkpointId: checkpoint.id,
    expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '测试' });
  await assert.rejects(readCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId }), /OUTPUT_NOT_ACTIVE/);
  assert.deepEqual(await readFile(copy.destination), bytes);
  await assert.rejects(createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id, outputId }), /OUTPUT_STALE/);
  const undo = await rollback.preview({ caseId: f.record.id, checkpointId: restored.undoCheckpoint.id });
  await rollback.apply({ caseId: f.record.id, checkpointId: restored.undoCheckpoint.id,
    expectedRevision: undo.expectedRevision, previewToken: undo.token, actor: '测试' });
  assert.deepEqual((await readCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId })).manifest, manifest);
});

test('exports refuse overwrite and managed paths including junction aliases, while another case cannot borrow output IDs', async (t) => {
  const f = await fixture(t);
  const output = await createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id });
  const base = { dataDir: f.directory, caseId: f.record.id, outputId: output.outputId, format: 'md' as const };
  const destination = join(f.directory, 'exports', '底稿.md');
  await exportCaseOutput({ ...base, destination });
  await assert.rejects(exportCaseOutput({ ...base, destination }), /EEXIST/);
  await assert.rejects(exportCaseOutput({ ...base, destination: join(f.directory, 'cases', 'forbidden.md') }), /OUTPUT_EXPORT_DESTINATION_INVALID/);
  const alias = join(f.directory, 'case-alias'); await symlink(join(f.directory, 'cases'), alias, 'junction');
  await assert.rejects(exportCaseOutput({ ...base, destination: join(alias, 'forbidden.md') }), /OUTPUT_EXPORT_DESTINATION_INVALID/);
  const second = await f.cases.create({ title: '别案', actor: '测试' });
  await assert.rejects(readCaseOutput({ dataDir: f.directory, caseId: second.id, outputId: output.outputId }), /OUTPUT_NOT_ACTIVE/);
  await assert.rejects(createCaseOutput({ dataDir: f.directory, caseId: second.id, runId: f.run.id }), /OUTPUT_SOURCE_NOT_ACTIVE/);
  await assert.rejects(readCaseOutput({ dataDir: f.directory, caseId: '../escape', outputId: output.outputId }));
});

test('saved output corruption blocks reading and checkpoint capture without modifying the case', async (t) => {
  const f = await fixture(t);
  const output = await createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id });
  const read = await readCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId: output.outputId });
  const before = (await f.cases.read(f.record.id)).revision;
  await writeFile(read.paths.docx, 'not a Word file');
  await assert.rejects(readCaseOutput({ dataDir: f.directory, caseId: f.record.id, outputId: output.outputId }), /OUTPUT_CHANGED/);
  await assert.rejects(new CaseRollback(f.cases, f.workspace).createCheckpoint({ caseId: f.record.id, label: '拒绝损坏底稿', actor: '测试' }), /OUTPUT_CHANGED/);
  assert.equal((await new CaseStore(f.directory).read(f.record.id)).revision, before);
});

test('cancellation before or during generation never advertises an unfinished output', async (t) => {
  const f = await fixture(t), before = (await f.cases.read(f.record.id)).revision;
  const pre = new AbortController(); pre.abort();
  await assert.rejects(createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id, signal: pre.signal }), /OUTPUT_CANCELLED/);
  const controller = new AbortController();
  const task = createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id, signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await assert.rejects(task, /OUTPUT_CANCELLED/);
  assert.equal((await f.cases.read(f.record.id)).revision, before);
  assert.equal((await listCaseOutputs({ dataDir: f.directory, caseId: f.record.id })).length, 0);
});

test('the planned case revision is checked before generation and stale operations stage nothing', async (t) => {
  const f = await fixture(t), revision = (await f.cases.read(f.record.id)).revision;
  await f.cases.update({ caseId: f.record.id, expectedRevision: revision, stage: '新增材料待核对', actor: '测试' });
  await assert.rejects(createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id,
    expectedRevision: revision }), /OUTPUT_STALE/);
  assert.equal((await listCaseOutputs({ dataDir: f.directory, caseId: f.record.id })).length, 0);
});

test('a staged immutable output is reconciled after a publication failure without rewriting its files', async (t) => {
  const f = await fixture(t), outputId = randomUUID(), original = CaseStore.prototype.commitWorkspace;
  CaseStore.prototype.commitWorkspace = async function (input, options) {
    if (input.note?.includes('保存底稿')) throw new Error('Simulated process failure before journal publication');
    return original.call(this, input, options);
  };
  try {
    await assert.rejects(createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id, outputId }), /Simulated process failure/);
  } finally { CaseStore.prototype.commitWorkspace = original; }
  const directory = join(f.directory, 'cases', f.record.id, 'outputs', outputId);
  const oldManifest = await readFile(join(directory, 'manifest.json'));
  const oldWord = await readFile(join(directory, 'draft.docx'));
  assert.equal((await listCaseOutputs({ dataDir: f.directory, caseId: f.record.id })).length, 0);
  const recovered = await createCaseOutput({ dataDir: f.directory, caseId: f.record.id, runId: f.run.id, outputId });
  assert.equal(recovered.outputId, outputId);
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), oldManifest);
  assert.deepEqual(await readFile(join(directory, 'draft.docx')), oldWord);
  assert.equal((await listCaseOutputs({ dataDir: f.directory, caseId: f.record.id })).length, 1);
});

test('outputs CLI creates and reopens a version in separate offline processes and exports Word', async (t) => {
  const f = await fixture(t), execute = promisify(execFile), cli = resolve('examples/outputs.ts');
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT']) if (process.env[name] !== undefined) environment[name] = process.env[name];
  const run = (...args: string[]) => execute(process.execPath, [cli, ...args, '--data-dir', f.directory, '--case', f.record.id], { env: environment });
  const created = JSON.parse((await run('create', '--run', f.run.id)).stdout);
  assert.ok(created.outputId);
  const shown = (await run('show', '--output', created.outputId)).stdout;
  assert.match(shown, /6000 CNY/u); assert.match(shown, /currentInputMatches/u);
  const destination = join(f.directory, 'exports', '离线底稿.docx');
  const exported = JSON.parse((await run('export', '--output', created.outputId, '--out', destination)).stdout);
  assert.equal(exported.outputId, created.outputId);
  assert.match(zipXml(await readFile(destination), 'word/document.xml'), /接案材料整理底稿/u);
  assert.equal(JSON.parse((await run('list')).stdout).length, 1);
});
