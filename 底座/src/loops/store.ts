import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CaseError, CaseStore } from '../cases/store.ts';
import { caseIdSchema, type CaseWorkspaceState } from '../cases/contracts.ts';
import { MaterialTextStore } from '../materials/versions.ts';
import { loopRunRequestSchema, loopRunSchema, readIssuesFitScope, type LoopRun, type LoopSource } from './contracts.ts';
import { validateProfessionalReview } from '../information/professional.ts';
import { validateInformationAnalysis, validateInformationReview, validateStructuredFindings } from '../information/validate.ts';

type RunEntry = NonNullable<CaseWorkspaceState['loopRuns']>[number];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceKey = (source: LoopSource) => `${source.materialId}/${source.versionId}/${source.textSha256}`;
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

function splitsPair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** A second validation boundary for persisted results and case checkpoints. */
async function validateRunSources(caseRoot: string, caseId: string, state: CaseWorkspaceState, run: LoopRun): Promise<void> {
  validateStructuredFindings(run.findings);
  if (run.information) validateInformationAnalysis(run.information, run.needs, run.findings, run.sources);
  if (JSON.stringify(run.information) !== JSON.stringify(run.rounds.at(-1)?.review.analysis)) {
    throw new CaseError('LOOP_RUN_INVALID', 'Final information analysis differs from the last professional review.');
  }
  if (JSON.stringify(run.professionalReview) !== JSON.stringify(run.rounds.at(-1)?.review.professionalReview))
    throw new CaseError('LOOP_RUN_INVALID', 'Final professional review differs from its accepted round.');
  const professionalIdentity = run.professionalReview?.reviewer;
  for (const round of run.rounds) {
    if (
      professionalIdentity &&
      JSON.stringify(round.review.professionalReview?.reviewer) !== JSON.stringify(professionalIdentity)
    )
      throw new CaseError('LOOP_RUN_INVALID', 'Professional reviewer identity changed within a run.');
    const professional = round.review.professionalReview;
    if (professional) {
      validateProfessionalReview(professional, { needs: run.needs, findings: run.findings, sources: run.sources });
      const reads = professional.actions.filter((action) => action.kind === 'read');
      if (
        reads.some(
          (action) =>
            !round.review.nextRequests.some(
              (request) =>
                request.checkId === action.checkId &&
                request.needId === action.needId &&
                request.instruction === action.instruction,
            ),
        ) ||
        round.review.nextRequests.some(
          (request) =>
            request.checkId &&
            !reads.some((action) => action.checkId === request.checkId && action.needId === request.needId),
        )
      )
        throw new CaseError('LOOP_RUN_INVALID', 'Professional next actions differ from the recorded schedule.');
    } else if (round.review.nextRequests.some((request) => request.checkId))
      throw new CaseError('LOOP_RUN_INVALID', 'A professional read lacks its review.');
  }
  const attempts = run.rounds.flatMap((round) => round.attempts);
  const groups = new Map<string, typeof attempts>();
  for (const attempt of attempts)
    if (attempt.batch) {
      const group = groups.get(attempt.batch.id) ?? [];
      group.push(attempt);
      groups.set(attempt.batch.id, group);
    }
  for (const group of groups.values()) {
    const first = group[0]!;
    if (
      !run.providers.readBatch ||
      new Set(first.batch!.needIds).size !== first.batch!.needIds.length ||
      group.length !== first.batch!.needIds.length ||
      new Set(group.map((attempt) => attempt.request.needId)).size !== group.length ||
      group.some(
        (attempt) =>
          !first.batch!.needIds.includes(attempt.request.needId) ||
          JSON.stringify(attempt.batch) !== JSON.stringify(first.batch) ||
          JSON.stringify((attempt.request.sources ?? run.sources).map(sourceKey).sort()) !==
            JSON.stringify((first.request.sources ?? run.sources).map(sourceKey).sort()),
      )
    )
      throw new CaseError('LOOP_RUN_INVALID', 'Grouped-read accounting is incomplete or inconsistent.');
  }
  const reads = groups.size + attempts.filter((attempt) => !attempt.batch).length;
  if (reads > run.limits.maxReads || (run.providers.readBatch && attempts.some((attempt) => !attempt.batch)))
    throw new CaseError('LOOP_RUN_INVALID', 'Reading trace exceeds or disguises its read budget.');
  if (run.status === 'completed' && run.professionalReview && run.professionalReview.decision !== 'ready')
    throw new CaseError('LOOP_RUN_INVALID', 'Completed run hides pending professional checks.');
  for (const round of run.rounds) if (round.review.analysis) {
    // Earlier reviews may refer to a subset of the final findings, all of which remain immutable.
    validateInformationAnalysis(round.review.analysis, run.needs, run.findings, run.sources);
    validateInformationReview(round.review.analysis, round.review.assessments);
  }
  if (run.caseId !== caseId || Date.parse(run.finishedAt) < Date.parse(run.createdAt)) {
    throw new CaseError('LOOP_RUN_INVALID', 'Loop identity or timestamps do not match.');
  }
  const selected = new Map<string, string>();
  const texts = new MaterialTextStore(caseRoot);
  for (const source of run.sources) {
    const key = sourceKey(source);
    const material = state.materials.find((item) => item.materialId === source.materialId);
    const saved = material?.versions.find((item) => item.versionId === source.versionId);
    if (selected.has(key) || saved?.textSha256 !== source.textSha256) {
      throw new CaseError('LOOP_SOURCE_NOT_ACTIVE', 'Loop sources must be unique text versions in the saved case state.');
    }
    const view = await texts.readVersion({ materialId: source.materialId, versionId: source.versionId });
    if (view.material.groupId !== caseId || view.material.sha256 !== material!.originalSha256
      || view.version.textSha256 !== source.textSha256) {
      throw new CaseError('LOOP_SOURCE_CHANGED', 'Loop source differs from its registered case or checksum.');
    }
    selected.set(key, view.version.text);
  }
  for (const round of run.rounds) {
    for (const attempt of round.attempts) {
      if (attempt.examined.some((source) => !selected.has(sourceKey(source)))) {
        throw new CaseError('LOOP_SOURCE_NOT_SELECTED', 'Reading trace refers to an unselected source.');
      }
      if (attempt.readIssues && (!readIssuesFitScope(attempt.readIssues, attempt.examined, attempt.request.sources ?? run.sources)
        || attempt.readIssues.some((issue) => !selected.has(sourceKey(issue.source))))) {
        throw new CaseError('LOOP_RUN_INVALID', 'Reading issues must be unique, targeted and unexamined.');
      }
    }
  }
  for (const finding of run.findings) {
    for (const citation of finding.citations) {
      const text = selected.get(sourceKey(citation));
      if (text === undefined || citation.end > text.length || splitsPair(text, citation.start)
        || splitsPair(text, citation.end) || text.slice(citation.start, citation.end) !== citation.quote) {
        throw new CaseError('LOOP_CITATION_INVALID', 'Loop citation must match the selected text version and UTF-16 range.');
      }
    }
  }
}

/** Validate a fixed run against a target case view, independent of the current view. */
export async function validateSavedLoopRun(
  caseRoot: string, entry: RunEntry, caseId: string, state: CaseWorkspaceState,
): Promise<LoopRun> {
  const id = caseIdSchema.parse(caseId);
  const runId = caseIdSchema.parse(entry.runId);
  const path = join(caseRoot, 'loop-runs', `${runId}.json`);
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if (missing(error)) throw new CaseError('LOOP_RUN_NOT_FOUND', 'A saved loop run is missing.');
    throw error;
  }
  if (hash(bytes) !== entry.sha256) throw new CaseError('LOOP_RUN_CHANGED', 'Saved loop run differs from its committed checksum.');
  let run: LoopRun;
  try { run = loopRunSchema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch { throw new CaseError('LOOP_RUN_INVALID', 'Saved loop run does not satisfy its contract.'); }
  if (run.id !== runId || run.caseId !== id) throw new CaseError('LOOP_RUN_INVALID', 'Loop identity differs from its case or filename.');
  await validateRunSources(caseRoot, id, state, run);
  return run;
}

/** Immutable completed loop records, advertised only by the case CAS journal. */
export class LoopRunStore {
  readonly #dataDir: string;
  readonly #cases: CaseStore;

  constructor(dataDir: string, cases?: CaseStore) {
    this.#dataDir = resolve(dataDir);
    this.#cases = cases ?? new CaseStore(this.#dataDir);
  }

  async save(input: LoopRun, options: { signal?: AbortSignal } = {}): Promise<LoopRun> {
    const active = () => { if (options.signal?.aborted) throw new CaseError('LOOP_RUN_CANCELLED', 'Loop saving was cancelled before publication.'); };
    active();
    const run = loopRunSchema.parse(input);
    const current = await this.#cases.readState(run.caseId);
    if (current.record.revision !== run.baseCaseRevision) {
      throw new CaseError('LOOP_RUN_STALE', 'Case changed during this loop; start a new run from the current case.');
    }
    if (!current.workspace) throw new CaseError('CASE_WORKSPACE_UNINITIALIZED', 'Initialize legacy case materials before running a loop.');
    const workspace = structuredClone(current.workspace);
    if ((workspace.loopRuns ?? []).some((entry) => entry.runId === run.id)) {
      throw new CaseError('LOOP_RUN_EXISTS', 'This immutable loop ID is already committed.');
    }
    const root = this.#cases.directory(run.caseId);
    await validateRunSources(root, run.caseId, workspace, run);
    active();
    const bytes = Buffer.from(`${JSON.stringify(run, null, 2)}\n`, 'utf8');
    const entry = { runId: run.id, sha256: hash(bytes) };
    const directory = join(root, 'loop-runs');
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `${run.id}.${randomUUID()}.tmp`);
    let ownTemporary = false;
    try {
      const handle = await open(temporary, 'wx');
      ownTemporary = true;
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      await link(temporary, join(directory, `${run.id}.json`));
    } finally {
      if (ownTemporary) await unlink(temporary).catch(() => {});
    }
    workspace.loopRuns = [...(workspace.loopRuns ?? []), entry];
    try {
      active();
      await this.#cases.commitWorkspace({ caseId: run.caseId, expectedRevision: run.baseCaseRevision,
        workspace, actor: '系统：信息整理循环', note: `保存循环记录 ${run.id}（${run.status}）` }, options);
    } catch (error) {
      if (error instanceof CaseError && error.code === 'CASE_REVISION_CONFLICT') {
        throw new CaseError('LOOP_RUN_STALE', 'Case changed before this loop could be committed; the staged record was retained outside the current view.');
      }
      throw error;
    }
    return run;
  }

  async read(input: { caseId: string; runId: string }): Promise<LoopRun> {
    const request = loopRunRequestSchema.parse(input);
    const current = await this.#cases.readState(request.caseId);
    const entry = current.workspace?.loopRuns?.find((item) => item.runId === request.runId);
    if (!entry || !current.workspace) throw new CaseError('LOOP_RUN_NOT_ACTIVE', 'No such loop run in the selected case view.');
    return validateSavedLoopRun(this.#cases.directory(request.caseId), entry, request.caseId, current.workspace);
  }
}
