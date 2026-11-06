import { createHash, randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import type { CapabilityRef, PluginHost } from '../contracts.ts';
import { CASE_CAPABILITIES, caseContentsSchema, caseRecordSchema } from '../cases/contracts.ts';
import { textVersionViewSchema } from '../materials/text-contracts.ts';
import { validateProfessionalReview } from '../information/professional.ts';
import { normalizeInformationRecord } from '../information/normalize.ts';
import { validateInformationAnalysis, validateInformationReview, validateStructuredFindings } from '../information/validate.ts';
import {
  loopDeclarationSchema, loopReadingSchema, loopBatchReadingSchema, loopReviewSchema, loopRunSchema, loopStartSchema, loopCheckpointSchema, readIssuesFitScope,
  type LoopCitation, type LoopDocument, type LoopFinding, type LoopReadRequest, type LoopRun,
  type LoopSource, type LoopStartInput, type LoopCheckpoint,
} from './contracts.ts';

export class LoopError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = 'LoopError'; this.code = code; }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = (value: string) => value.trim().replace(/\s+/gu, ' ');
const sourceKey = (source: LoopSource) => `${source.materialId}/${source.versionId}/${source.textSha256}`;
const requestKey = (request: LoopReadRequest) => digest([request.needId, request.checkId ?? normalized(request.instruction), request.sources?.map(sourceKey).sort() ?? null]);
const readCount = (attempts: LoopRun['rounds'][number]['attempts']) => new Set(attempts.map((attempt,index)=>attempt.batch?.id ?? `single-${index}`)).size;
function parse<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new LoopError('LOOP_PROTOCOL_INVALID', `${label} does not satisfy the loop contract.`);
  return result.data;
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new LoopError('LOOP_PROTOCOL_INVALID', `${label} must be unique.`);
}
function boundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  const before = text.charCodeAt(index - 1), after = text.charCodeAt(index);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

/** Checks provenance, not whether a proposed statement is semantically true. */
export function validateLoopCitation(citation: LoopCitation, documents: readonly LoopDocument[]): void {
  const document = documents.find((item) => sourceKey(item) === sourceKey(citation));
  if (!document || citation.end > document.text.length || citation.start < 0 || citation.end <= citation.start
    || !boundary(document.text, citation.start) || !boundary(document.text, citation.end)
    || document.text.slice(citation.start, citation.end) !== citation.quote) {
    throw new LoopError('LOOP_CITATION_INVALID', 'Citation must match an explicitly selected version, checksum and exact text range.');
  }
}

/**
 * Application-level coordinator: professional and reader plugins are independent
 * capabilities, not mutually dependent hosts. One run has a frozen input set.
 */
export class IntakeLoop {
  readonly #host: PluginHost;
  constructor(host: PluginHost) { this.#host = host; }

  async run(input: LoopStartInput, execution: {
    signal?: AbortSignal; resume?: LoopCheckpoint;
    currentCaseRevision?: () => number;
    onCheckpoint?: (checkpoint: LoopCheckpoint) => Promise<void>;
  } = {}): Promise<LoopRun> {
    const request = loopStartSchema.parse(input);
    unique(request.sources.map((source) => `${source.materialId}/${source.versionId}`), 'Selected text versions');
    if (request.readingMode === 'batch' && !request.readBatch) throw new LoopError('LOOP_PROTOCOL_INVALID','Batch mode requires a registered grouped reader.');
    const providers = { declare: this.#provider(request.declare), read: this.#provider(request.read), review: this.#provider(request.review), ...(request.readBatch ? {readBatch:this.#provider(request.readBatch)} : {}) };
    const restored = execution.resume ? loopCheckpointSchema.parse(execution.resume) : undefined;
    if (restored && (JSON.stringify(restored.request) !== JSON.stringify(request) || JSON.stringify(restored.providers) !== JSON.stringify(providers))) {
      throw new LoopError('LOOP_RESUME_CHANGED', 'Resume requires the same goal, source versions, limits and provider versions.');
    }
    // Opening also initializes the inventory of a legacy case before freezing it.
    const opened = caseContentsSchema.parse(await this.#call(CASE_CAPABILITIES.contents, { caseId: request.caseId }));
    const baseRevision = opened.case.revision;
    if (restored && !execution.currentCaseRevision && baseRevision !== restored.sourceCaseRevision) {
      throw new LoopError('LOOP_RESUME_CHANGED', 'Case changed since this checkpoint; a managed execution context must verify the input before resuming.');
    }
    const assertCurrent = async () => {
      if (execution.signal?.aborted) throw new LoopError('LOOP_CANCELLED', 'Loop execution was cancelled.');
      const current = caseRecordSchema.parse(await this.#call(CASE_CAPABILITIES.read, { caseId: request.caseId }));
      if (current.revision !== (execution.currentCaseRevision?.() ?? baseRevision)) {
        throw new LoopError('LOOP_SOURCE_CHANGED', 'Case changed during the loop; start a new run against the chosen current versions.');
      }
    };
    const documents: LoopDocument[] = [];
    for (const source of request.sources) {
      const view = textVersionViewSchema.parse(await this.#call(CASE_CAPABILITIES.readVersion, {
        caseId: request.caseId, materialId: source.materialId, versionId: source.versionId,
      }));
      if (view.version.textSha256 !== source.textSha256) {
        throw new LoopError('LOOP_SOURCE_CHANGED', 'Selected source checksum differs from its saved text version.');
      }
      documents.push({ ...source, sourceLabel: view.material.sourceLabel, text: view.version.text });
    }
    await assertCurrent();
    const createdAt = restored?.createdAt ?? new Date().toISOString();
    const runId = restored?.runId ?? randomUUID();
    const declaration = restored?.declaration ?? parse(loopDeclarationSchema, await this.#call(request.declare, { caseId: request.caseId, goal: request.goal, sources: request.sources }), 'Declaration');
    await assertCurrent();
    unique(declaration.needs.map((need) => need.id), 'Information need IDs');
    const needs = new Map(declaration.needs.map((need) => [need.id, need]));
    const validateRequests = (requests: LoopReadRequest[]) => {
      for (const item of requests) {
        if (!needs.has(item.needId)) throw new LoopError('LOOP_PROTOCOL_INVALID', 'Read request refers to an undeclared information need.');
        if (item.sources) {
          unique(item.sources.map(sourceKey), 'Targeted sources');
          if (item.sources.some((source) => !request.sources.some((selected) => sourceKey(source) === sourceKey(selected)))) {
            throw new LoopError('LOOP_PROTOCOL_INVALID', 'Read task targets an unselected source version.');
          }
        }
      }
    };
    validateRequests(declaration.requests);
    const findings: LoopFinding[] = structuredClone(restored?.findings ?? []);
    const findingKeys = new Map<string, LoopFinding>();
    const rounds: LoopRun['rounds'] = structuredClone(restored?.rounds ?? []);
    let pendingAttempts = structuredClone(restored?.pendingAttempts ?? []);
    const attempts = [...rounds.flatMap((round) => round.attempts), ...pendingAttempts];
    const tried = new Set(attempts.map((attempt) => requestKey(attempt.request)));
    if (tried.size !== attempts.length || readCount(attempts) > request.limits.maxReads || rounds.length > request.limits.maxRounds) {
      throw new LoopError('LOOP_RESUME_INVALID', 'Checkpoint contains repeated work or exceeds its original budget.');
    }
    const batchGroups = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      if (attempt.batch) {
        if (
          request.readingMode !== 'batch' ||
          new Set(attempt.batch.needIds).size !== attempt.batch.needIds.length ||
          !attempt.batch.needIds.includes(attempt.request.needId)
        )
          throw new LoopError('LOOP_RESUME_INVALID', 'Invalid grouped-read metadata.');
        const group = batchGroups.get(attempt.batch.id) ?? [];
        group.push(attempt);
        batchGroups.set(attempt.batch.id, group);
      } else if (request.readingMode === 'batch')
        throw new LoopError('LOOP_RESUME_INVALID', 'A grouped-read checkpoint lost its batch accounting.');
    }
    for (const group of batchGroups.values()) {
      const expected = group[0]!.batch!.needIds;
      if (
        group.length !== expected.length ||
        new Set(group.map((attempt) => attempt.request.needId)).size !== expected.length ||
        group.some(
          (attempt) =>
            JSON.stringify(attempt.batch!.needIds) !== JSON.stringify(expected) ||
            JSON.stringify((attempt.request.sources ?? request.sources).map(sourceKey).sort()) !==
              JSON.stringify((group[0]!.request.sources ?? request.sources).map(sourceKey).sort()),
        )
      )
        throw new LoopError('LOOP_RESUME_INVALID', 'A grouped read must commit all requested needs atomically.');
    }
    validateStructuredFindings(findings);
    unique(findings.map((finding) => finding.id), 'Checkpoint finding IDs');
    for (const finding of findings) {
      if (!needs.has(finding.needId)) throw new LoopError('LOOP_RESUME_INVALID', 'Checkpoint finding refers to an undeclared need.');
      for (const citation of finding.citations) validateLoopCitation(citation, documents);
      findingKeys.set(digest([finding.needId, normalized(finding.statement), finding.citations.map((citation) => JSON.stringify(citation)).sort(), finding.record ?? null]), finding);
    }
    for (const attempt of attempts) {
      validateRequests([attempt.request]);
      const target = attempt.request.sources ?? request.sources;
      if (new Set(attempt.examined.map(sourceKey)).size !== attempt.examined.length
        || !readIssuesFitScope(attempt.readIssues ?? [], attempt.examined, target)
        || new Set(attempt.findingIds).size !== attempt.findingIds.length
        || attempt.findingIds.some((id) => !findings.some((finding) => finding.id === id && finding.needId === attempt.request.needId
          && finding.citations.every((citation) => attempt.examined.some((source) => sourceKey(source) === sourceKey(citation)))))
        || attempt.examined.some((source) => !target.some((selected) => sourceKey(selected) === sourceKey(source)))) {
        throw new LoopError('LOOP_RESUME_INVALID', 'Checkpoint reading trace has foreign records or sources.');
      }
    }
    if (findings.some((finding) => !attempts.some((attempt) => attempt.findingIds.includes(finding.id)))) {
      throw new LoopError('LOOP_RESUME_INVALID', 'Every checkpoint finding must be backed by a completed read.');
    }
    for (const [index, round] of rounds.entries()) {
      const assessments = round.review.assessments;
      if (round.number !== index + 1 || assessments.length !== needs.size || new Set(assessments.map((item) => item.needId)).size !== needs.size
        || assessments.some((item) => !needs.has(item.needId) || item.findingIds.some((id) => !findings.some((finding) => finding.id === id))
          || (item.status === 'satisfied' && item.findingIds.length === 0))) {
        throw new LoopError('LOOP_RESUME_INVALID', 'Checkpoint round sequence or assessment is invalid.');
      }
      validateRequests(round.review.nextRequests);
      if (round.review.professionalReview) validateProfessionalReview(round.review.professionalReview,{needs:declaration.needs,findings,sources:request.sources});
      if (round.review.analysis) {
        validateInformationAnalysis(round.review.analysis, declaration.needs, findings, request.sources);
        validateInformationReview(round.review.analysis, round.review.assessments);
      }
    }
    let requests = structuredClone(restored?.requests ?? declaration.requests);
    validateRequests(requests);
    if (restored && JSON.stringify(requests) !== JSON.stringify(rounds.at(-1)?.review.nextRequests ?? declaration.requests)) {
      throw new LoopError('LOOP_RESUME_INVALID', 'Checkpoint pending tasks differ from its last accepted review.');
    }
    if (restored?.outcome) {
      const last = rounds.at(-1)?.review;
      const completed = last?.assessments.every((item) => item.status === 'satisfied' || item.status === 'not_applicable') && (!last?.professionalReview || last.professionalReview.decision === 'ready');
      if ((restored.outcome.status === 'completed' && (!completed || last!.nextRequests.length > 0 || pendingAttempts.length > 0))
        || (restored.outcome.status === 'needs_review' && (!last || completed || last.nextRequests.length > 0 || pendingAttempts.length > 0))
        || (restored.outcome.status === 'stalled' && (pendingAttempts.length > 0 || requests.some((item) => !tried.has(requestKey(item)))))
        || (restored.outcome.status === 'limit_reached' && readCount(attempts) < request.limits.maxReads && rounds.length < request.limits.maxRounds)) {
        throw new LoopError('LOOP_RESUME_INVALID', 'Checkpoint completion or budget outcome is not supported by its trace.');
      }
    }
    let status: LoopRun['status'] = restored?.outcome?.status ?? 'limit_reached';
    let reason = restored?.outcome?.reason ?? '已达到本次循环的轮数或读取次数上限，仍有事项待核对。';
    let finished = restored?.outcome !== undefined;
    const checkpoint = async (outcome?: { status: LoopRun['status']; reason: string }) => {
      await assertCurrent();
      if (execution.onCheckpoint) await execution.onCheckpoint(loopCheckpointSchema.parse({
        version: 1, runId, request, sourceCaseRevision: restored?.sourceCaseRevision ?? baseRevision,
        createdAt, providers, declaration, findings, rounds, pendingAttempts, requests, ...(outcome ? { outcome } : {}),
      }));
      await assertCurrent();
    };
    if (!restored) await checkpoint();
    for (let number = rounds.length + 1; !finished && number <= request.limits.maxRounds; number += 1) {
      // Duplicate instructions with only a changed reason do not trigger another read.
      const scheduled = new Set<string>();
      const pending = requests.filter((item) => {
        const key = requestKey(item);
        if (tried.has(key) || scheduled.has(key)) return false;
        scheduled.add(key); return true;
      });
      if (pending.length === 0 && pendingAttempts.length === 0) { status = 'stalled'; reason = '专业复核只提出已执行过的读取任务，没有新的补查动作。'; break; }
      const roundAttempts = pendingAttempts;
      const jobs: LoopReadRequest[][] = [];
      for (const item of pending) {
        if (request.readingMode !== 'batch') {
          jobs.push([item]);
          continue;
        }
        const sources = JSON.stringify((item.sources ?? request.sources).map(sourceKey).sort());
        const group = jobs.find(
          (group) =>
            group.length < 8 &&
            !group.some((task) => task.needId === item.needId) &&
            JSON.stringify((group[0]!.sources ?? request.sources).map(sourceKey).sort()) === sources,
        );
        if (group) group.push(item);
        else jobs.push([item]);
      }
      for (const job of jobs) {
        if (readCount(attempts) >= request.limits.maxReads) break;
        await assertCurrent();
        const targeted = job[0]!.sources
          ? documents.filter((document) => job[0]!.sources!.some((source) => sourceKey(source) === sourceKey(document)))
          : documents;
        const groupedReading = request.readingMode === 'batch'
          ? parse(loopBatchReadingSchema, await this.#call(request.readBatch!, {
              caseId: request.caseId, round: number,
              needs: job.map(item => needs.get(item.needId)!), requests: job,
              documents: targeted, findings,
            }), 'Grouped reading')
          : undefined;
        const results = groupedReading?.results ?? [{
          needId: job[0]!.needId,
          ...parse(loopReadingSchema, await this.#call(request.read, {
            caseId: request.caseId, round: number, need: needs.get(job[0]!.needId)!,
            request: job[0]!, documents: targeted, findings,
          }), 'Reading'),
        }];
        await assertCurrent();
        if (
          results.length !== job.length ||
          new Set(results.map((result) => result.needId)).size !== job.length ||
          results.some((result) => !job.some((item) => item.needId === result.needId))
        )
          throw new LoopError(
            'LOOP_PROTOCOL_INVALID',
            'Grouped reader must explicitly complete every requested need exactly once.',
          );
        // Validate the whole batch before modifying checkpointed state.
        for (const reading of results) {
          unique(reading.examined.map(sourceKey), 'Examined text versions');
          if (reading.examined.some((source) => !targeted.some((document) => sourceKey(source) === sourceKey(document))))
            throw new LoopError('LOOP_PROTOCOL_INVALID', 'Reader examined an unselected source.');
          if (!readIssuesFitScope(reading.readIssues ?? [], reading.examined, targeted))
            throw new LoopError('LOOP_PROTOCOL_INVALID', 'Reader issues must be unique, targeted and unexamined.');
          for (const candidate of reading.candidates) {
            for (const citation of candidate.citations) {
              validateLoopCitation(citation, targeted);
              if (!reading.examined.some((source) => sourceKey(source) === sourceKey(citation)))
                throw new LoopError('LOOP_CITATION_INVALID', 'Citation was not in the reader examined sources.');
            }
            if (candidate.record)
              candidate.record = normalizeInformationRecord(
                candidate.record,
                candidate.citations.map((citation) => citation.quote).join('\n'),
              );
          }
        }
        const batch =
          request.readingMode === 'batch' ? { id: randomUUID(), needIds: job.map((item) => item.needId), ...(groupedReading?.stats ?? {}) } : undefined;
        for (const item of job) {
          const reading = results.find((result) => result.needId === item.needId)!;
          const findingIds: string[] = [];
          for (const candidate of reading.candidates) {
            const key = digest([
              item.needId,
              normalized(candidate.statement),
              candidate.citations.map((citation) => JSON.stringify(citation)).sort(),
              candidate.record ?? null,
            ]);
            let finding = findingKeys.get(key);
            if (!finding) {
              finding = { ...candidate, id: randomUUID(), needId: item.needId };
              findingKeys.set(key, finding);
              findings.push(finding);
            }
            if (!findingIds.includes(finding.id)) findingIds.push(finding.id);
          }
          const attempt = {
            request: item,
            examined: reading.examined,
            findingIds,
            note: reading.note,
            ...(reading.readIssues ? { readIssues: reading.readIssues } : {}),
            ...(batch ? { batch } : {}),
          };
          roundAttempts.push(attempt);
          attempts.push(attempt);
          tried.add(requestKey(item));
        }
        await checkpoint();
      }
      if (roundAttempts.length === 0) break;
      const review = parse(loopReviewSchema, await this.#call(request.review, {
        caseId: request.caseId, goal: request.goal, round: number, needs: declaration.needs, findings, attempts, sources: request.sources,
      }), 'Review');
      await assertCurrent();
      unique(review.assessments.map((item) => item.needId), 'Reviewed information need IDs');
      if (review.assessments.length !== needs.size || review.assessments.some((item) => !needs.has(item.needId))) {
        throw new LoopError('LOOP_PROTOCOL_INVALID', 'Review must assess every declared need exactly once.');
      }
      for (const assessment of review.assessments) {
        if (assessment.findingIds.some((id) => !findings.some((finding) => finding.id === id))
          || (assessment.status === 'satisfied' && assessment.findingIds.length === 0)) {
          throw new LoopError('LOOP_PROTOCOL_INVALID', 'Review must cite existing findings; satisfied needs require a source-backed finding.');
        }
      }
      validateRequests(review.nextRequests);
      if (review.professionalReview) validateProfessionalReview(review.professionalReview,{needs:declaration.needs,findings,sources:request.sources});
      if (review.analysis) {
        validateInformationAnalysis(review.analysis, declaration.needs, findings, request.sources);
        validateInformationReview(review.analysis, review.assessments);
      }
      rounds.push({ number, attempts: roundAttempts, review });
      pendingAttempts = [];
      const complete = review.assessments.every((item) => item.status === 'satisfied' || item.status === 'not_applicable') && (!review.professionalReview || review.professionalReview.decision === 'ready');
      if (complete) {
        if (review.nextRequests.length > 0) throw new LoopError('LOOP_PROTOCOL_INVALID', 'A completed review cannot also request further reading.');
        status = 'completed'; reason = '专业插件已核对本次声明的信息需求；这不代表相关陈述已被证实或法律结论成立。'; finished = true;
      }
      if (!finished && review.nextRequests.length === 0) {
        status = 'needs_review'; reason = '仍有未解决或冲突的信息，专业插件没有提出进一步读取任务，保留给人工核对。'; finished = true;
      }
      requests = review.nextRequests;
      await checkpoint(finished ? { status, reason } : undefined);
    }
    // The case journal detects ordinary writes; re-reading also detects damage
    // to immutable source bytes outside the managed API while a call was running.
    for (const source of request.sources) {
      const view = textVersionViewSchema.parse(await this.#call(CASE_CAPABILITIES.readVersion, {
        caseId: request.caseId, materialId: source.materialId, versionId: source.versionId,
      }));
      if (view.version.textSha256 !== source.textSha256) throw new LoopError('LOOP_SOURCE_CHANGED', 'Selected text changed during the loop.');
    }
    await assertCurrent();
    if (!finished) await checkpoint({ status, reason });
    return loopRunSchema.parse({
      id: runId, caseId: request.caseId, baseCaseRevision: execution.currentCaseRevision?.() ?? baseRevision, goal: request.goal,
      createdAt, finishedAt: new Date(Math.max(Date.now(), Date.parse(createdAt))).toISOString(),
      sources: request.sources, providers, limits: request.limits, needs: declaration.needs, findings, rounds, status, reason,
      ...(rounds.at(-1)?.review.analysis ? { information: rounds.at(-1)!.review.analysis } : {}),
      ...(rounds.at(-1)?.review.professionalReview ? {professionalReview:rounds.at(-1)!.review.professionalReview} : {}),
    });
  }

  #provider(ref: CapabilityRef): LoopRun['providers']['read'] {
    const capability = this.#host.listCapabilities().find((item) => item.id === ref.id && item.version === ref.version);
    if (!capability) throw new LoopError('LOOP_PROVIDER_MISSING', `No configured loop provider for ${ref.id}@${ref.version}.`);
    return { capability: { ...ref }, pluginId: capability.provider.id, pluginVersion: capability.provider.version };
  }

  async #call(ref: CapabilityRef, input: unknown): Promise<unknown> {
    const result = await this.#host.invoke(ref, structuredClone(input));
    if (result.status !== 'success') {
      const detail = result.status === 'error' ? `${result.error.code}: ${result.error.message}` : result.reason;
      throw new LoopError('LOOP_CAPABILITY_FAILED', `${ref.id}: ${detail}`);
    }
    return result.data;
  }
}
