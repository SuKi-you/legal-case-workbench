import { z } from 'zod';
import { loopReadingSchema, loopReadIssueCodeSchema, type LoopDocument, type LoopReadIssue, type LoopSource } from '../loops/contracts.ts';
import { validateLoopCitation } from '../loops/engine.ts';
import {
  buildInformationExtractionSystem,
  buildInformationSemanticReviewSystem,
  extractionSchema,
  extractInformation,
  informationRepairInstruction,
  locateInformationQuote,
  segmentInformationDocuments,
  semanticReviewSchema,
  type InformationExtractionOptions,
} from './extract.ts';
import { type StructuredNeed } from './contracts.ts';
import { normalizeInformationRecord } from './normalize.ts';
import { InformationError } from './errors.ts';
import type { JsonModel } from './model.ts';

const splittableErrors = new Set(['INFORMATION_MODEL_OUTPUT_INVALID', 'INFORMATION_BATCH_INCOMPLETE']);
type BatchOptions = InformationExtractionOptions & { allowPartialReads?: boolean };
type ReadingResult = z.infer<typeof loopReadingSchema> & { needId: string };

function issueCode(error: unknown): LoopReadIssue['code'] | undefined {
  if (!(error instanceof InformationError)) return undefined;
  const parsed = loopReadIssueCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : undefined;
}

function sourceOf({ materialId, versionId, textSha256 }: LoopDocument): LoopSource {
  return { materialId, versionId, textSha256 };
}

function sameSource(left: LoopSource, right: LoopSource): boolean {
  return left.materialId === right.materialId && left.versionId === right.versionId && left.textSha256 === right.textSha256;
}

function recordIssue(result: ReadingResult, document: LoopDocument, code: LoopReadIssue['code']): void {
  const source = sourceOf(document);
  result.examined = result.examined.filter((item) => !sameSource(item, source));
  result.candidates = result.candidates.filter((item) => item.citations.every((citation) => !sameSource(citation, source)));
  (result.readIssues ??= []).push({ source, code });
  result.note = '已保留通过校验的来源。校验未通过的需求与材料配对待人工核对。';
}

function schemaForNeeds(needs: readonly StructuredNeed[]) {
  return z.strictObject({
    results: z
      .array(extractionSchema.extend({ needId: z.enum(needs.map((need) => need.id)) }))
      .min(needs.length)
      .max(needs.length),
  });
}
/** Grouping changes transport cost; each need must still receive an explicit result. */
async function extractInformationGrouped(
  model: JsonModel,
  documents: readonly LoopDocument[],
  needs: readonly StructuredNeed[],
  options: BatchOptions = {},
) {
  if (needs.length < 1 || needs.length > 8 || new Set(needs.map((need) => need.id)).size !== needs.length)
    throw new InformationError('INFORMATION_BATCH_INVALID', 'A batch must have one to eight distinct declared needs.');
  const active = () => {
    if (options.signal?.aborted) throw new InformationError('INFORMATION_CANCELLED', 'Grouped reading was cancelled.');
  };
  const segments = segmentInformationDocuments(documents, options.maxSegmentChars);
  const maxSegments = options.maxSegments ?? 32;
  if (!Number.isInteger(maxSegments) || maxSegments < 1 || maxSegments > 100)
    throw new InformationError('INFORMATION_LIMIT_INVALID', 'Segment budget must be an integer between 1 and 100.');
  if (segments.length > maxSegments)
    throw new InformationError(
      'INFORMATION_INPUT_LIMIT',
      'Too many text segments; narrow the source scope rather than truncate it.',
    );
  const maxRepairs = options.maxRepairAttempts ?? 1;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 2)
    throw new InformationError('INFORMATION_LIMIT_INVALID', 'Invalid grouped-reading repair budget.');
  const activeNeeds = needs.filter((need) => need.spec?.applicable !== false);
  const results: ReadingResult[] = needs.map((need) => ({
    needId: need.id,
    examined:
      need.spec?.applicable === false
        ? []
        : documents.map(({ materialId, versionId, textSha256 }) => ({ materialId, versionId, textSha256 })),
    candidates: [] as z.infer<typeof loopReadingSchema>['candidates'],
    note: '已逐项提交并校验提取结果；未提取到不等于事实不存在。',
  }));
  if (activeNeeds.length === 0) return { results };
  for (const segment of segments) {
    let pending = activeNeeds.filter((need) => !results.find((result) => result.needId === need.id)!.readIssues
      ?.some((issue) => sameSource(issue.source, segment.document)));
    let previous: { rejectedOutput: unknown; feedback: string } | undefined;
    let semanticFailure: InformationError | undefined;
    for (let repair = 0; repair <= maxRepairs && pending.length > 0; repair++) {
      active();
      const batchSchema = schemaForNeeds(pending);
      const system =
        buildInformationExtractionSystem(batchSchema) +
        '\n本次按needId分别回答所有需求。results必须恰好包含每个请求的needId一次；无相关信息也显式返回该needId和items:[]。不能只回答部分需求。每个items只能回答它所属needId的问题。';
      const base = {
        needs: pending,
        requiredNeedIds: pending.map((need) => need.id),
        segment: {
          id: segment.id,
          sourceLabel: segment.document.sourceLabel,
          sourceKind: options.sourceKinds?.[segment.document.materialId] ?? 'party_statement',
          text: segment.text,
        },
      };
      const raw = await model.complete({
        system: system + (previous ? informationRepairInstruction : ''),
        user: JSON.stringify({ ...base, ...previous }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      active();
      try {
        if (raw !== null && typeof raw === 'object' && 'results' in raw && Array.isArray(raw.results)) {
          const ids = raw.results.flatMap((item: unknown) =>
            item !== null && typeof item === 'object' && 'needId' in item && typeof item.needId === 'string'
              ? [item.needId] : [],
          );
          const missing = pending.filter((need) => !ids.includes(need.id)).map((need) => need.id);
          const duplicateCount = ids.length - new Set(ids).size;
          const undeclaredCount = ids.filter((id) => !pending.some((need) => need.id === id)).length;
          if (missing.length || duplicateCount || undeclaredCount || raw.results.length !== pending.length) {
            throw new InformationError('INFORMATION_BATCH_INCOMPLETE',
              `Each requested need requires exactly one result. Missing needIds: ${missing.join(', ') || 'none'}; duplicate IDs: ${duplicateCount}; undeclared IDs: ${undeclaredCount}; expected results: ${pending.length}.`);
          }
        }
        const parsed = batchSchema.safeParse(raw);
        if (!parsed.success)
          throw new InformationError(
            'INFORMATION_MODEL_OUTPUT_INVALID',
            `Grouped extraction has invalid fields: ${parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.map(String).join('.') || 'root'} (${issue.code})`).join('; ')}. Follow the supplied schema; use null for unknown nullable fields and explicit empty items only when unrelated.`,
          );
        if (
          parsed.data.results.length !== pending.length ||
          new Set(parsed.data.results.map((result) => result.needId)).size !== pending.length ||
          parsed.data.results.some((result) => !pending.some((need) => need.id === result.needId))
        )
          throw new InformationError(
            'INFORMATION_BATCH_INCOMPLETE',
            'Grouped extraction must explicitly answer every requested need exactly once.',
          );
        const accepted: { needId: string; candidate: z.infer<typeof loopReadingSchema>['candidates'][number] }[] = [];
        for (const result of parsed.data.results) {
          const need = needs.find((need) => need.id === result.needId)!;
          for (const item of result.items) {
            if (!need.spec || item.record.topic !== need.spec.topic)
              throw new InformationError(
                'INFORMATION_TOPIC_INVALID',
                'A grouped record uses a topic outside its own declared need.',
              );
            const citations = item.quotes.map((quote) => {
              if (quote.segmentId !== segment.id)
                throw new InformationError('INFORMATION_QUOTE_INVALID', 'Grouped extraction quoted another segment.');
              const start = locateInformationQuote(segment, quote.quote, quote.occurrence);
              const citation = {
                materialId: segment.document.materialId,
                versionId: segment.document.versionId,
                textSha256: segment.document.textSha256,
                start,
                end: start + quote.quote.length,
                quote: quote.quote,
              };
              validateLoopCitation(citation, documents);
              return citation;
            });
            const rawFields = [
              item.record.subject?.name,
              item.record.subject?.identity?.value,
              item.record.object?.name,
              item.record.object?.identity?.value,
              item.record.attributedTo?.name,
              item.record.attributedTo?.identity?.value,
              item.record.event.key,
              item.record.time.raw,
              item.record.value.raw,
              item.record.basis,
            ];
            const quoted = citations.map((citation) => citation.quote).join('\n');
            if (rawFields.some((field) => field != null && !quoted.includes(field) && segment.text.includes(field)))
              citations.push({
                materialId: segment.document.materialId,
                versionId: segment.document.versionId,
                textSha256: segment.document.textSha256,
                start: segment.start,
                end: segment.end,
                quote: segment.text,
              });
            if (item.record.origin !== 'inference')
              item.record.origin = options.sourceKinds?.[segment.document.materialId] ?? 'party_statement';
            const record = normalizeInformationRecord(
              item.record,
              citations.map((citation) => citation.quote).join('\n'),
            );
            accepted.push({ needId: result.needId, candidate: { statement: item.statement, record, citations } });
          }
        }
        if (accepted.length > 200)
          throw new InformationError(
            'INFORMATION_INPUT_LIMIT',
            'A grouped segment returned too many candidates; narrow the need batch.',
          );
        if (options.verifySemantics !== false && accepted.length > 0) {
          active();
          const review = await model.complete({
            reasoning: 'high',
            system:
              buildInformationSemanticReviewSystem() +
              '\n本次每条items带needId，必须对照该needId自己的question/reason/spec核对；不能用同批另一个需求的相关性替代本条的相关性。',
            user: JSON.stringify({
              ...base,
              items: accepted.map((item, index) => ({ ...item.candidate, needId: item.needId, index })),
            }),
            ...(options.signal ? { signal: options.signal } : {}),
          });
          active();
          const checked = semanticReviewSchema.safeParse(review);
          if (
            !checked.success ||
            checked.data.verdicts.length !== accepted.length ||
            new Set(checked.data.verdicts.map((verdict) => verdict.index)).size !== accepted.length ||
            checked.data.verdicts.some((verdict) => verdict.index >= accepted.length)
          )
            throw new InformationError(
              'INFORMATION_SEMANTIC_INVALID',
              'Semantic review must check every grouped candidate exactly once.',
            );
          const invalid = checked.data.verdicts.filter(
            (verdict) => !verdict.relevant || !verdict.supported || !verdict.rolesCorrect || !verdict.polarityCorrect,
          );
          if (invalid.length) {
            const rejection = new InformationError(
              'INFORMATION_SEMANTIC_REJECTED',
              invalid.map((verdict) => `item ${verdict.index}: ${verdict.reason}`).join('; '),
            );
            if (!options.allowPartialReads) throw rejection;
            // A complete verifier result authorizes only needs whose every candidate passed.
            // Re-read only rejected needs, with their rejected output supplied as correction data.
            const rejected = new Set(invalid.map((verdict) => accepted[verdict.index]!.needId));
            for (const item of accepted) {
              if (!rejected.has(item.needId)) results.find((result) => result.needId === item.needId)!.candidates.push(item.candidate);
            }
            pending = pending.filter((need) => rejected.has(need.id));
            semanticFailure = rejection;
            if (repair === maxRepairs) {
              for (const need of pending) recordIssue(results.find((result) => result.needId === need.id)!, segment.document, 'INFORMATION_SEMANTIC_REJECTED');
              break;
            }
            previous = { rejectedOutput: parsed.data.results.filter((result) => rejected.has(result.needId)), feedback: rejection.message };
            continue;
          }
        }
        for (const item of accepted)
          results.find((result) => result.needId === item.needId)!.candidates.push(item.candidate);
        break;
      } catch (error) {
        if (!(error instanceof InformationError) && !(error instanceof Error && error.name === 'LoopError'))
          throw error;
        if (error instanceof InformationError &&
          (error.code === 'INFORMATION_SEMANTIC_REJECTED' || error.code === 'INFORMATION_SEMANTIC_INVALID')) {
          semanticFailure = error;
        }
        if (repair === maxRepairs) {
          // A malformed correction cannot change a rejected segment into a transport-only failure.
          const terminal = semanticFailure && error instanceof InformationError && splittableErrors.has(error.code) ? semanticFailure : error;
          const code = issueCode(terminal);
          if (options.allowPartialReads && code) {
            for (const need of pending) recordIssue(results.find((result) => result.needId === need.id)!, segment.document, code);
            break;
          }
          if (terminal !== error) throw terminal;
          throw error;
        }
        previous = { rejectedOutput: raw, feedback: error.message };
      }
    }
  }
  active();
  return { results };
}

/**
 * A bounded recovery for explicit transport/shape omissions, never a relaxation
 * of citation, topic or semantic checks. At most three binary splits reach the
 * original single-need extractor. Every branch uses the caller's same model port.
 */
export async function extractInformationBatch(
  model: JsonModel,
  documents: readonly LoopDocument[],
  needs: readonly StructuredNeed[],
  options: BatchOptions = {},
) {
  if (needs.length < 1 || needs.length > 8 || new Set(needs.map((need) => need.id)).size !== needs.length) {
    throw new InformationError('INFORMATION_BATCH_INVALID', 'A batch must have one to eight distinct declared needs.');
  }
  const assertActive = () => {
    if (options.signal?.aborted) throw new InformationError('INFORMATION_CANCELLED', 'Grouped reading was cancelled.');
  };
  const stats = { splits: 0, singleReads: 0 };
  const read = async (selected: readonly StructuredNeed[]): Promise<ReadingResult[]> => {
    assertActive();
    if (selected.length === 1) {
      const need = selected[0]!;
      if (need.spec?.applicable === false) {
        return [{ needId: need.id, examined: [], candidates: [], note: '专业插件已声明此需求不适用。' }];
      }
      stats.singleReads++;
      if (options.allowPartialReads) return (await extractInformationGrouped(model, documents, selected, options)).results;
      const reading = await extractInformation(model, documents, selected, {
        ...options,
        verifySemantics: options.verifySemantics !== false,
      });
      assertActive();
      return [{ needId: need.id, ...reading }];
    }
    try {
      return (await extractInformationGrouped(model, documents, selected, options)).results;
    } catch (error) {
      if (!(error instanceof InformationError) || !splittableErrors.has(error.code)) throw error;
      // Discard every candidate in the rejected parent response. Successful
      // children are held locally until both sides have completed and validated.
      assertActive();
      stats.splits++;
      const middle = Math.ceil(selected.length / 2);
      const left = await read(selected.slice(0, middle));
      const right = await read(selected.slice(middle));
      return [...left, ...right];
    }
  };
  const results = await read(needs);
  assertActive();
  return { results, stats };
}
