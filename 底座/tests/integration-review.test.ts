import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createOutputFixture } from '../examples/output-fixtures.ts';
import { createCaseOutput, exportCaseOutput, readCaseOutput } from '../src/outputs/store.ts';
import { CaseStore } from '../src/cases/store.ts';
import { CaseRollback } from '../src/cases/rollback.ts';
import { LoopRunStore } from '../src/loops/store.ts';
import { LegalAgent } from '../src/agent/engine.ts';
import type { JsonModel } from '../src/information/model.ts';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-output-coverage-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, ...await createOutputFixture(dataDir) };
}

test('a newly generated document cannot promote an older run to current analysis after new material arrives', async (t) => {
  const f = await fixture(t);
  const original = await createCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, runId: f.run.id });
  const before = await readCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, outputId: original.outputId });
  assert.equal(before.currentInputMatches, true); assert.equal(before.analysisCoversCurrentInput, true);
  assert.deepEqual(before.sourceCoverage, { unreadMaterialIds: [], ambiguousMaterialIds: [], unparsedAttachmentIds: [] });
  const added = await f.workspace.registerText({ caseId: f.record.id, sourceLabel: '新补充事实', text: '另一份材料尚未整理。' });
  const createdNow = await createCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, runId: f.run.id });
  const after = await readCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, outputId: createdNow.outputId });
  assert.equal(after.currentInputMatches, true, 'the document captures today\'s index');
  assert.equal(after.analysisCoversCurrentInput, false, 'the older analysis did not read the added material');
  assert.deepEqual(after.sourceCoverage.unreadMaterialIds, [added.id]);
  assert.equal(after.draft.findings.length, f.run.findings.length);
  assert.match(after.markdown, /未纳入本次整理/u);
  const copy = await exportCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, outputId: createdNow.outputId,
    format: 'md', destination: join(f.dataDir, 'exports', '历史选择范围.md') });
  assert.equal(copy.currentInputMatches, true); assert.equal(copy.analysisCoversCurrentInput, false);
  assert.deepEqual(copy.sourceCoverage.unreadMaterialIds, [added.id]);
});

test('corrections and ambiguous branches remain uncovered until the chosen current text has actually been read', async (t) => {
  const f = await fixture(t), selected = f.selections[0]!;
  const original = await f.workspace.readVersion({ caseId: f.record.id, ...selected });
  const revision = await f.workspace.saveRevision({ caseId: f.record.id, materialId: selected.materialId,
    baseVersionId: selected.versionId, baseTextSha256: original.version.textSha256, text: original.version.text.replace('6000', '7000'), editor: '测试核对员' });
  const corrected = await createCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, runId: f.run.id });
  const correctedRead = await readCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, outputId: corrected.outputId });
  assert.equal(correctedRead.currentInputMatches, true); assert.equal(correctedRead.analysisCoversCurrentInput, false);
  assert.deepEqual(correctedRead.sourceCoverage.unreadMaterialIds, [selected.materialId]);
  await f.workspace.saveRevision({ caseId: f.record.id, materialId: selected.materialId,
    baseVersionId: selected.versionId, baseTextSha256: original.version.textSha256, text: '独立修订分支，尚未决定采用哪个版本。', editor: '另一核对员' });
  const branched = await createCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, runId: f.run.id });
  const branchedRead = await readCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, outputId: branched.outputId });
  assert.equal(branchedRead.analysisCoversCurrentInput, false);
  assert.deepEqual(branchedRead.sourceCoverage.ambiguousMaterialIds, [selected.materialId]);
  assert.equal(branchedRead.sourceCoverage.unreadMaterialIds.includes(selected.materialId), false);
  assert.ok(revision.id !== selected.versionId);
});

test('registered opaque attachments are reported as unparsed instead of silently counted as covered', async (t) => {
  const f = await fixture(t), path = join(f.dataDir, 'provided.pdf');
  await writeFile(path, Buffer.from('%PDF-1.4 fictional attachment fixture'));
  const attachment = await f.workspace.importFile({ caseId: f.record.id, path, sourceLabel: '尚未解析的附件' });
  const manifest = await createCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, runId: f.run.id });
  const output = await readCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, outputId: manifest.outputId });
  assert.equal(output.currentInputMatches, true); assert.equal(output.analysisCoversCurrentInput, false);
  assert.deepEqual(output.sourceCoverage.unparsedAttachmentIds, [attachment.id]);
  assert.deepEqual(output.sourceCoverage.unreadMaterialIds, []);
});

test('committed older Markdown formatting stays readable and idempotent after the renderer changes', async (t) => {
  const f = await fixture(t), outputId = randomUUID();
  const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  const commit = CaseStore.prototype.commitWorkspace;
  let previousMarkdown = '';
  // Simulate the older creator's formatting before its first journal commit.
  // All immutable hashes are published once, exactly as with a real old build.
  const patch = t.mock.method(CaseStore.prototype, 'commitWorkspace', async function (this: CaseStore, ...args: Parameters<typeof commit>) {
    const [input, options] = args;
    const entry = input.workspace.outputs?.find((item) => item.outputId === outputId);
    if (entry) {
      const directory = join(this.directory(input.caseId), 'outputs', outputId);
      const manifestPath = join(directory, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      previousMarkdown = `# 既有版本的排版\n\n${await readFile(join(directory, 'draft.md'), 'utf8')}`;
      await writeFile(join(directory, 'draft.md'), previousMarkdown);
      manifest.files.md = { name: 'draft.md', sha256: digest(previousMarkdown), byteLength: Buffer.byteLength(previousMarkdown) };
      const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(manifestPath, bytes); entry.sha256 = digest(bytes);
    }
    return commit.call(this, input, options);
  });
  await createCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, runId: f.run.id, outputId }); patch.mock.restore();
  const saved = await readCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, outputId });
  assert.equal(saved.markdown, previousMarkdown);
  const beforeRevision = (await f.cases.read(f.record.id)).revision;
  const same = await createCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, runId: f.run.id, outputId });
  assert.deepEqual(same, saved.manifest);
  assert.equal((await f.cases.read(f.record.id)).revision, beforeRevision);
  const destination = join(f.dataDir, 'exports', '既有排版.md');
  await exportCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, outputId, format: 'md', destination });
  assert.equal(await readFile(destination, 'utf8'), previousMarkdown);
  await writeFile(saved.paths.md, `${previousMarkdown}未经版本保存的篡改`);
  await assert.rejects(readCaseOutput({ dataDir: f.dataDir, caseId: f.record.id, outputId }), /OUTPUT_CHANGED/);
});

test('a rollback after the information run commits cannot authorize its late session progress to publish', async (t) => {
  const f = await fixture(t), rollback = new CaseRollback(f.cases, f.workspace);
  const model: JsonModel = { id: 'rollback-boundary-fixture-only', model: 'no-network', async complete(input) {
    if (input.system.includes('LEGAL_AGENT_ACTION')) {
      const payload = JSON.parse(input.user);
      const result = payload.observations.find((item: { toolId: string }) => item.toolId === 'information.organize');
      return result ? { kind: 'reply', message: '整理已完成。', evidenceStepIds: [result.stepId] }
        : { kind: 'tool', toolId: 'information.organize', toolVersion: 1, arguments: { profileId: 'test.boundary', selections: f.selections }, reason: '核验发布边界' };
    }
    if (input.system.includes('LEGAL_AGENT_REPLY_REVIEW')) return { supported: true, necessary: true, reason: '仅机制夹具' };
    return f.model.complete(input);
  } };
  const agent = await LegalAgent.create({ dataDir: f.dataDir, model,
    profiles: [{ id: 'test.boundary', version: '1', description: '固定虚构材料', needs: f.needs }] });
  t.after(() => agent.close());
  const save = LoopRunStore.prototype.save;
  let rollbackRevision: number | undefined;
  const patch = t.mock.method(LoopRunStore.prototype, 'save', async function (this: LoopRunStore, ...args: Parameters<typeof save>) {
    const run = await save.apply(this, args);
    const checkpoint = await rollback.createCheckpoint({ caseId: f.record.id, label: '运行已提交但工具回执尚未完成', actor: '并发窗口' });
    const preview = await rollback.preview({ caseId: f.record.id, checkpointId: checkpoint.id });
    const restored = await rollback.apply({ caseId: f.record.id, checkpointId: checkpoint.id,
      expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '并发窗口' });
    rollbackRevision = restored.case.revision;
    return run;
  });
  const late = await agent.send({ caseId: f.record.id, message: '整理并检查这些虚构材料。' }); patch.mock.restore();
  assert.ok(rollbackRevision !== undefined);
  assert.equal((await f.cases.read(f.record.id)).revision, rollbackRevision, 'the late operation must not append progress after rollback');
  const restored = await agent.read({ caseId: f.record.id, sessionId: late.id });
  assert.equal(restored.steps.find((step) => step.toolId === 'information.organize')!.status, 'running');
  assert.equal(restored.tasks.find((task) => task.id === restored.activeTaskId)!.status, 'running', 'the checkpoint task state remains intact');
  assert.match(late.tasks.find((task) => task.id === late.activeTaskId)!.error!, /AGENT_STALE/u);
});
