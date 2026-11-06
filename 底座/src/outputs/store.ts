import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { CaseError, CaseStore } from '../cases/store.ts';
import { CaseWorkspace } from '../cases/workspace.ts';
import { caseIdSchema, type CaseWorkspaceState } from '../cases/contracts.ts';
import { validateSavedLoopRun } from '../loops/store.ts';
import type { LoopRun } from '../loops/contracts.ts';
import { nodeReviewKindSchema, type NodeReviewKind, type NodeReviewContributor } from '../node-review/contracts.ts';
import { buildNodeReview } from '../node-review/index.ts';
import { buildOutputDraft, outputInputFingerprint, outputReadIssues } from './draft.ts';
import { renderOutputDocx, renderOutputMarkdown } from './render.ts';
import { outputDraftSchema, outputManifestSchema, outputSectionSchema, type OutputDraft, type OutputManifest, type OutputFormat, type OutputSection } from './contracts.ts';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
type OutputEntry = { outputId: string; sha256: string };
const identity = z.strictObject({ caseId: caseIdSchema, outputId: z.uuid() });
const requestSchema = z.strictObject({ caseId: caseIdSchema, runId: z.uuid(), outputId: z.uuid().optional(),
  previousOutputId: z.uuid().optional(), node: nodeReviewKindSchema.optional(), sections: z.array(outputSectionSchema).max(30).default([]) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const active = (signal?: AbortSignal) => { if (signal?.aborted) throw new CaseError('OUTPUT_CANCELLED', 'Output creation was cancelled before publication.'); };

async function readLimited(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_OUTPUT_BYTES) throw new CaseError('OUTPUT_FILE_INVALID', 'Expected an output file no larger than 50 MiB.');
  const bytes = await readFile(path);
  if (bytes.length > MAX_OUTPUT_BYTES) throw new CaseError('OUTPUT_FILE_INVALID', 'Output file exceeds its size limit.');
  return bytes;
}
async function writeNew(path: string, bytes: Buffer): Promise<void> {
  if (bytes.length > MAX_OUTPUT_BYTES) throw new CaseError('OUTPUT_FILE_INVALID', 'Output file exceeds its size limit.');
  const handle = await open(path, 'wx');
  let complete = false;
  try { await handle.writeFile(bytes); await handle.close(); complete = true; }
  finally { if (!complete) { await handle.close().catch(() => {}); await unlink(path).catch(() => {}); } }
}
async function parseManifest(root: string, outputId: string): Promise<{ manifest: OutputManifest; bytes: Buffer }> {
  let bytes: Buffer;
  try { bytes = await readLimited(join(root, 'outputs', outputId, 'manifest.json')); }
  catch (error) { if (missing(error)) throw new CaseError('OUTPUT_NOT_FOUND', 'The output manifest is missing.'); throw error; }
  try { return { manifest: outputManifestSchema.parse(JSON.parse(bytes.toString('utf8'))), bytes }; }
  catch { throw new CaseError('OUTPUT_INVALID', 'The output manifest is malformed.'); }
}

/** The supplied checkpoint view is authoritative; no fallback to the current case. */
export async function validateSavedOutput(
  caseRoot: string, entry: OutputEntry, caseId: string, state: CaseWorkspaceState,
): Promise<OutputManifest> {
  const id = caseIdSchema.parse(caseId), outputId = z.uuid().parse(entry.outputId);
  const { manifest, bytes } = await parseManifest(caseRoot, outputId);
  if (hash(bytes) !== entry.sha256) throw new CaseError('OUTPUT_CHANGED', 'Output manifest differs from its committed checksum.');
  if (manifest.outputId !== outputId || manifest.caseId !== id) throw new CaseError('OUTPUT_INVALID', 'Output identity differs from its case or directory.');
  const files: Partial<Record<OutputFormat, Buffer>> = {};
  for (const [format, file] of Object.entries(manifest.files) as [OutputFormat, OutputManifest['files'][OutputFormat]][]) {
    const content = await readLimited(join(caseRoot, 'outputs', outputId, file.name));
    if (content.length !== file.byteLength || hash(content) !== file.sha256) throw new CaseError('OUTPUT_CHANGED', 'A saved output file differs from its committed checksum.');
    files[format] = content;
  }
  let draft: OutputDraft;
  try { draft = outputDraftSchema.parse(JSON.parse(files.json!.toString('utf8'))); }
  catch { throw new CaseError('OUTPUT_INVALID', 'Saved structured output does not satisfy its contract.'); }
  if (draft.outputId !== outputId || draft.caseId !== id || draft.runId !== manifest.runId || draft.createdAt !== manifest.createdAt
    || draft.templateVersion !== manifest.templateVersion || draft.inputFingerprint !== manifest.inputFingerprint
    || draft.case.id !== id || !same(draft.sources, manifest.sources)
    || (draft.changes?.previousOutputId ?? null) !== manifest.previousOutputId) {
    throw new CaseError('OUTPUT_INVALID', 'Draft provenance differs from its manifest.');
  }
  if (manifest.previousOutputId !== null && !state.outputs?.some((item) => item.outputId === manifest.previousOutputId)) {
    throw new CaseError('OUTPUT_SOURCE_NOT_ACTIVE', 'Output predecessor is outside the supplied case view.');
  }
  const runEntry = state.loopRuns?.find((item) => item.runId === manifest.runId);
  if (!runEntry) throw new CaseError('OUTPUT_SOURCE_NOT_ACTIVE', 'Output refers to a run outside the supplied case view.');
  const run = await validateSavedLoopRun(caseRoot, runEntry, id, state);
  if (draft.nodeReview) {
    const previousEntry = state.outputs?.find(item => item.outputId === manifest.previousOutputId);
    if (!previousEntry || draft.nodeReview.caseId !== id || draft.nodeReview.currentRunId !== run.id) {
      throw new CaseError('OUTPUT_INVALID', 'Node review identity differs from the current case or run.');
    }
    const previous = await parseManifest(caseRoot, previousEntry.outputId);
    if (hash(previous.bytes) !== previousEntry.sha256 || previous.manifest.caseId !== id
      || previous.manifest.outputId !== previousEntry.outputId || draft.nodeReview.baselineRunId !== previous.manifest.runId
      || !state.loopRuns?.some(item => item.runId === previous.manifest.runId)) {
      throw new CaseError('OUTPUT_INVALID', 'Node review baseline is outside its fixed case view.');
    }
  }
  if (!same(draft.sources, run.sources) || !same(draft.needs, run.needs) || !same(draft.findings, run.findings)
    || !same(draft.analysis, run.information ?? null) || !same(draft.professionalReview ?? null, run.professionalReview ?? null)
    || !same(draft.readIssues ?? [], outputReadIssues(run))
    || draft.goal !== run.goal || draft.runStatus !== run.status || draft.runReason !== run.reason) {
    throw new CaseError('OUTPUT_INVALID', 'Output facts differ from the fixed source run.');
  }
  for (const material of draft.materials) {
    const saved = state.materials.find((item) => item.materialId === material.materialId);
    if (!saved || saved.originalSha256 !== material.originalSha256
      || material.availableVersionIds.some((versionId) => !saved.versions.some((version) => version.versionId === versionId))) {
      throw new CaseError('OUTPUT_SOURCE_NOT_ACTIVE', 'Output material index is outside the supplied case view.');
    }
  }
  for (const attachment of draft.attachments) if (!state.files.some((file) => file.fileId === attachment.fileId && file.sha256 === attachment.sha256)) {
    throw new CaseError('OUTPUT_SOURCE_NOT_ACTIVE', 'Output attachment index is outside the supplied case view.');
  }
  const findings = new Set(run.findings.map((item) => item.id));
  if (draft.references.some((reference) => !findings.has(reference.findingId)
    || !run.findings.find((finding) => finding.id === reference.findingId)!.citations.some((citation) => same(citation, reference.citation)))) {
    throw new CaseError('OUTPUT_INVALID', 'Output reference is not a citation in the fixed run.');
  }
  // A saved rendition belongs to the renderer used when this version was
  // created. Its committed bytes must remain readable after layout changes;
  // rendering it again with today's formatter is not an integrity check.
  return manifest;
}

async function assertCurrentSources(workspace: CaseWorkspace, state: CaseWorkspaceState, caseId: string, run: LoopRun) {
  const selected = new Map(run.sources.map(source => [source.materialId, source]));
  const unreadMaterialIds: string[] = [];
  if (selected.size !== run.sources.length)
    throw new CaseError('AGENT_OUTPUT_STALE', '每份材料须选择一个当前文字版本。');
  for (const material of state.materials) {
    const versions = await workspace.listVersions({ caseId, materialId: material.materialId });
    const parents = new Set(versions.flatMap(version => version.kind === 'revision' ? [version.baseVersionId] : []));
    const leaves = versions.filter(version => !parents.has(version.id));
    const source = selected.get(material.materialId);
    if (leaves.length === 0 && !source) {
      unreadMaterialIds.push(material.materialId);
      continue;
    }
    if (!source || !leaves.some(version => version.id === source.versionId && version.textSha256 === source.textSha256)) {
      throw new CaseError('AGENT_OUTPUT_STALE', '当前文字范围与整理运行不同，请先按当前版本重新整理。');
    }
  }
  return unreadMaterialIds;
}

export async function createCaseOutput(input: {
  dataDir: string; caseId: string; runId: string; outputId?: string; previousOutputId?: string;
  sections?: readonly OutputSection[]; signal?: AbortSignal; expectedRevision?: number; requireCurrentSources?: boolean;
  node?: NodeReviewKind; contributeNodeReview?: NodeReviewContributor;
}): Promise<OutputManifest> {
  active(input.signal);
  const request = requestSchema.parse({ caseId: input.caseId, runId: input.runId,
    ...(input.outputId ? { outputId: input.outputId } : {}), ...(input.previousOutputId ? { previousOutputId: input.previousOutputId } : {}),
    ...(input.node ? { node: input.node } : {}), ...(input.sections ? { sections: input.sections } : {}) });
  if (request.node && !request.previousOutputId)
    throw new CaseError('OUTPUT_NODE_BASELINE_REQUIRED', '节点审查须指定同案上一版底稿。');
  const cases = new CaseStore(input.dataDir), workspace = new CaseWorkspace(input.dataDir, cases);
  const current = await workspace.snapshotState(request.caseId);
  if (input.expectedRevision !== undefined && current.record.revision !== z.number().int().positive().parse(input.expectedRevision)) {
    throw new CaseError('OUTPUT_STALE', 'Case changed after this output operation was planned.');
  }
  const outputId = request.outputId ?? randomUUID(), root = cases.directory(request.caseId);
  if (request.previousOutputId === outputId) throw new CaseError('OUTPUT_PREDECESSOR_INVALID', 'An output cannot be its own predecessor.');
  const requestFingerprint = hash(JSON.stringify({ caseId: request.caseId, runId: request.runId,
    previousOutputId: request.previousOutputId ?? null, sections: request.sections, ...(request.node ? { node: request.node } : {}) }));
  const existing = current.workspace.outputs?.find((item) => item.outputId === outputId);
  if (existing) {
    const manifest = await validateSavedOutput(root, existing, request.caseId, current.workspace);
    if (manifest.requestFingerprint !== requestFingerprint) throw new CaseError('OUTPUT_ID_CONFLICT', 'This output ID already represents a different request.');
    return manifest;
  }
  let staged: { manifest: OutputManifest; bytes: Buffer } | undefined;
  try { staged = await parseManifest(root, outputId); }
  catch (error) { if (!(error instanceof CaseError && error.code === 'OUTPUT_NOT_FOUND')) throw error; }
  if (staged) {
    if (staged.manifest.requestFingerprint !== requestFingerprint) throw new CaseError('OUTPUT_ID_CONFLICT', 'The staged output ID represents a different request.');
    if (staged.manifest.inputFingerprint !== outputInputFingerprint(current.record, current.workspace)
      || (await cases.history(request.caseId)).some((event) => event.kind === 'rolled_back' && event.revision > staged!.manifest.sourceCaseRevision)) {
      throw new CaseError('OUTPUT_STALE', 'Staged output predates changed or restored case inputs; create a new output ID.');
    }
    const entry = { outputId, sha256: hash(staged.bytes) };
    await validateSavedOutput(root, entry, request.caseId, current.workspace);
    const state = structuredClone(current.workspace); state.outputs = [...(state.outputs ?? []), entry];
    active(input.signal);
    await cases.commitWorkspace({ caseId: request.caseId, expectedRevision: current.record.revision, workspace: state,
      actor: '系统：底稿导出', note: `恢复发布底稿 ${outputId}` }, input.signal ? { signal: input.signal } : {});
    return staged.manifest;
  }
  const runEntry = current.workspace.loopRuns?.find((entry) => entry.runId === request.runId);
  if (!runEntry) throw new CaseError('OUTPUT_SOURCE_NOT_ACTIVE', 'Select a saved run in this case.');
  const run = await validateSavedLoopRun(root, runEntry, request.caseId, current.workspace);
  const unreadMaterialIds = request.node || input.requireCurrentSources
    ? await assertCurrentSources(workspace, current.workspace, request.caseId, run) : [];
  const contents = await workspace.contents(request.caseId);
  let previous: OutputDraft | undefined;
  if (request.previousOutputId) previous = (await readCaseOutput({ dataDir: input.dataDir, caseId: request.caseId, outputId: request.previousOutputId })).draft;
  let nodeReview: OutputDraft['nodeReview'];
  if (request.node && previous) {
    const baseEntry = current.workspace.loopRuns?.find(entry => entry.runId === previous.runId);
    if (!baseEntry) throw new CaseError('OUTPUT_SOURCE_NOT_ACTIVE', '节点审查的基线运行不在当前案件视图。');
    const baseline = previous.runId === run.id ? run : await validateSavedLoopRun(root, baseEntry, request.caseId, current.workspace);
    nodeReview = buildNodeReview({ kind: request.node, baseline, current: run, currentScope: run.sources,
      unreadMaterialIds, unparsedAttachmentIds: current.workspace.files.map(file => file.fileId),
      ...(input.contributeNodeReview ? { contribute: input.contributeNodeReview } : {}) });
  }
  const draft = buildOutputDraft({ outputId, createdAt: new Date().toISOString(), contents, state: current.workspace,
    run, sections: request.sections, ...(previous ? { previous } : {}), ...(nodeReview ? { nodeReview } : {}) });
  const json = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  const md = Buffer.from(renderOutputMarkdown(draft), 'utf8');
  const docx = await renderOutputDocx(draft);
  active(input.signal);
  const file = <N extends string>(name: N, bytes: Buffer) => ({ name, sha256: hash(bytes), byteLength: bytes.length });
  const manifest = outputManifestSchema.parse({ version: 1, outputId, caseId: request.caseId, runId: request.runId,
    createdAt: draft.createdAt, templateVersion: draft.templateVersion, inputFingerprint: draft.inputFingerprint,
    requestFingerprint, previousOutputId: request.previousOutputId ?? null, sourceCaseRevision: current.record.revision,
    sources: run.sources, files: { json: file('draft.json', json), md: file('draft.md', md), docx: file('draft.docx', docx) } });
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const parent = join(root, 'outputs'); await mkdir(parent, { recursive: true });
  const staging = join(parent, `${outputId}.${randomUUID()}.staging`); await mkdir(staging);
  await writeNew(join(staging, 'draft.json'), json); await writeNew(join(staging, 'draft.md'), md);
  await writeNew(join(staging, 'draft.docx'), docx); await writeNew(join(staging, 'manifest.json'), bytes);
  try { await rename(staging, join(parent, outputId)); }
  catch (error) {
    // A concurrent writer may have published the same immutable operation ID.
    let winner: { manifest: OutputManifest; bytes: Buffer };
    try { winner = await parseManifest(root, outputId); } catch { throw error; }
    if (winner.manifest.requestFingerprint !== requestFingerprint) throw new CaseError('OUTPUT_ID_CONFLICT', 'Another writer used this output ID.');
    // Its journal publication determines success; retry is safe and never overwrites it.
    const latest = await cases.readState(request.caseId);
    const entry = latest.workspace?.outputs?.find((item) => item.outputId === outputId);
    if (entry && latest.workspace) return validateSavedOutput(root, entry, request.caseId, latest.workspace);
    throw new CaseError('OUTPUT_PUBLICATION_PENDING', 'The same output is staged by another writer; retry the same operation ID.');
  }
  const state = structuredClone(current.workspace);
  state.outputs = [...(state.outputs ?? []), { outputId, sha256: hash(bytes) }];
  active(input.signal);
  try {
    await cases.commitWorkspace({ caseId: request.caseId, expectedRevision: current.record.revision, workspace: state,
      actor: '系统：底稿导出', note: `保存底稿 ${outputId}` }, input.signal ? { signal: input.signal } : {});
  } catch (error) {
    if (error instanceof CaseError && error.code === 'CASE_REVISION_CONFLICT') throw new CaseError('OUTPUT_STALE', 'Case changed before output publication; the staged output is outside the current view.');
    throw error;
  }
  return manifest;
}

export async function readCaseOutput(input: { dataDir: string; caseId: string; outputId: string }) {
  const request = identity.parse({ caseId: input.caseId, outputId: input.outputId });
  const cases = new CaseStore(input.dataDir), state = await cases.readState(request.caseId);
  const entry = state.workspace?.outputs?.find((item) => item.outputId === request.outputId);
  if (!entry || !state.workspace) throw new CaseError('OUTPUT_NOT_ACTIVE', 'No such output in the selected case view.');
  const root = cases.directory(request.caseId), directory = join(root, 'outputs', request.outputId);
  const manifest = await validateSavedOutput(root, entry, request.caseId, state.workspace);
  const draft = outputDraftSchema.parse(JSON.parse((await readLimited(join(directory, 'draft.json'))).toString('utf8')));
  // A new document can faithfully describe an older selected run.  Capturing
  // today's index does not mean that run examined today's text branches.
  const workspace = new CaseWorkspace(input.dataDir, cases);
  const unreadMaterialIds: string[] = [], ambiguousMaterialIds: string[] = [];
  for (const material of state.workspace.materials) {
    const versions = await workspace.listVersions({ caseId: request.caseId, materialId: material.materialId });
    const parents = new Set(versions.flatMap((version) => version.kind === 'revision' ? [version.baseVersionId] : []));
    const leaves = versions.filter((version) => !parents.has(version.id));
    if (leaves.length > 1) ambiguousMaterialIds.push(material.materialId);
    else if (leaves.length === 0 || !manifest.sources.some((source) => source.materialId === material.materialId
      && source.versionId === leaves[0]!.id && source.textSha256 === leaves[0]!.textSha256)) unreadMaterialIds.push(material.materialId);
  }
  const sourceCoverage = { unreadMaterialIds, ambiguousMaterialIds, unparsedAttachmentIds: state.workspace.files.map((file) => file.fileId) };
  return { manifest, draft, markdown: (await readLimited(join(directory, 'draft.md'))).toString('utf8'),
    currentInputMatches: manifest.inputFingerprint === outputInputFingerprint(state.record, state.workspace),
    analysisCoversCurrentInput: sourceCoverage.unreadMaterialIds.length === 0 && sourceCoverage.ambiguousMaterialIds.length === 0
      && sourceCoverage.unparsedAttachmentIds.length === 0
      && draft.analysis?.needs.every(need => need.satisfaction === 'not_applicable' || need.unread.length === 0) === true,
    sourceCoverage,
    paths: { json: join(directory, 'draft.json'), md: join(directory, 'draft.md'), docx: join(directory, 'draft.docx') } };
}
export async function listCaseOutputs(input: { dataDir: string; caseId: string }) {
  const cases = new CaseStore(input.dataDir), caseId = caseIdSchema.parse(input.caseId), current = await cases.readState(caseId);
  const results: OutputManifest[] = [];
  for (const entry of current.workspace?.outputs ?? []) results.push(await validateSavedOutput(cases.directory(caseId), entry, caseId, current.workspace!));
  return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.outputId.localeCompare(b.outputId));
}
async function physicalLocation(path: string): Promise<string> {
  let ancestor = resolve(path); const tail: string[] = [];
  while (true) {
    try { return resolve(await realpath(ancestor), ...tail.reverse()); }
    catch (error) { if (!missing(error)) throw error; tail.push(basename(ancestor));
      const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; }
  }
}
export async function exportCaseOutput(input: {
  dataDir: string; caseId: string; outputId: string; format: OutputFormat; destination: string;
}) {
  const format = z.enum(['json', 'md', 'docx']).parse(input.format);
  const destination = z.string().trim().min(1).parse(input.destination);
  const output = await readCaseOutput(input), target = await physicalLocation(destination);
  for (const directory of ['cases', 'materials']) {
    const pathInRoot = relative(await physicalLocation(join(input.dataDir, directory)), target);
    if (!isAbsolute(pathInRoot) && pathInRoot !== '..' && !pathInRoot.startsWith(`..${sep}`)) {
      throw new CaseError('OUTPUT_EXPORT_DESTINATION_INVALID', 'Export outside managed cases/materials directories.');
    }
  }
  const bytes = await readLimited(output.paths[format]);
  if (hash(bytes) !== output.manifest.files[format].sha256) throw new CaseError('OUTPUT_CHANGED', 'Output changed before copying.');
  await mkdir(dirname(target), { recursive: true }); await writeNew(target, bytes);
  return { destination: target, sha256: hash(bytes), outputId: output.manifest.outputId, currentInputMatches: output.currentInputMatches,
    analysisCoversCurrentInput: output.analysisCoversCurrentInput, sourceCoverage: output.sourceCoverage };
}
