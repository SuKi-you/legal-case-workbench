import { createHash } from 'node:crypto';
import type { CaseContents, CaseRecord, CaseWorkspaceState } from '../cases/contracts.ts';
import type { LoopRun } from '../loops/contracts.ts';
import type { NodeReview } from '../node-review/contracts.ts';
import { outputDraftSchema, outputSectionSchema, type OutputDraft, type OutputSection } from './contracts.ts';

export function outputInputFingerprint(record: CaseRecord, state: CaseWorkspaceState): string {
  const metadata = { id: record.id, title: record.title, caseNumber: record.caseNumber,
    description: record.description, stage: record.stage, status: record.status };
  const materials = state.materials.map(({ materialId, originalSha256, versions }) => ({ materialId, originalSha256,
    versions: [...versions].sort((a, b) => a.versionId.localeCompare(b.versionId)),
  })).sort((a, b) => a.materialId.localeCompare(b.materialId));
  const files = [...state.files].sort((a, b) => a.fileId.localeCompare(b.fileId));
  return createHash('sha256').update(JSON.stringify({ metadata, materials, files })).digest('hex');
}
export function outputReadIssues(run: LoopRun) {
  return run.rounds.flatMap(round => round.attempts.flatMap(attempt =>
    (attempt.readIssues ?? []).map(issue => ({ ...issue, needId: attempt.request.needId }))));
}
const signature = (finding: LoopRun['findings'][number]) => JSON.stringify({ statement: finding.statement, record: finding.record,
  citations: finding.citations.map(({ materialId, versionId, textSha256, start, end }) => ({ materialId, versionId, textSha256, start, end })) });
function changes(previous: OutputDraft, run: LoopRun): OutputDraft['changes'] {
  const oldFindings = new Map(previous.findings.map((finding) => [signature(finding), finding.statement]));
  const newFindings = new Map(run.findings.map((finding) => [signature(finding), finding.statement]));
  const conflictKey = (conflict: NonNullable<LoopRun['information']>['conflicts'][number], findings: LoopRun['findings']) => JSON.stringify({
    field: conflict.field, classification: conflict.classification,
    claims: conflict.findingIds.map((id) => signature(findings.find((finding) => finding.id === id)!)).sort(),
  });
  const oldConflicts = new Map((previous.analysis?.conflicts ?? []).map((conflict) => [conflictKey(conflict, previous.findings), conflict.reason]));
  const newConflicts = new Map((run.information?.conflicts ?? []).map((conflict) => [conflictKey(conflict, run.findings), conflict.reason]));
  const oldNeeds = new Map((previous.analysis?.needs ?? []).map((need) => [need.needId, `${need.satisfaction}/${need.consistency}/${need.coverage}`]));
  const newNeeds = new Map((run.information?.needs ?? []).map((need) => [need.needId, `${need.satisfaction}/${need.consistency}/${need.coverage}`]));
  return { previousOutputId: previous.outputId,
    addedStatements: [...newFindings].filter(([key]) => !oldFindings.has(key)).map(([, value]) => value),
    removedStatements: [...oldFindings].filter(([key]) => !newFindings.has(key)).map(([, value]) => value),
    addedConflicts: [...newConflicts].filter(([key]) => !oldConflicts.has(key)).map(([, value]) => value),
    removedConflicts: [...oldConflicts].filter(([key]) => !newConflicts.has(key)).map(([, value]) => value),
    needChanges: [...new Set([...oldNeeds.keys(), ...newNeeds.keys()])].filter((id) => oldNeeds.get(id) !== newNeeds.get(id))
      .map((needId) => ({ needId, before: oldNeeds.get(needId) ?? null, after: newNeeds.get(needId) ?? null })),
  };
}

export function buildOutputDraft(input: {
  outputId: string; createdAt: string; contents: CaseContents; state: CaseWorkspaceState;
  run: LoopRun; sections?: readonly OutputSection[]; previous?: OutputDraft; nodeReview?: NodeReview;
}): OutputDraft {
  const { run, contents } = input;
  if (run.caseId !== contents.case.id) throw new Error('OUTPUT_CASE_MISMATCH: Run belongs to another case.');
  const findingIds = new Set(run.findings.map((finding) => finding.id));
  const sections = (input.sections ?? []).map((section) => outputSectionSchema.parse(section));
  if (new Set(sections.map((section) => section.id)).size !== sections.length) throw new Error('OUTPUT_SECTION_INVALID: Section IDs must be unique.');
  for (const section of sections) {
    if (section.paragraphs.length === 0 && section.tables.length === 0) throw new Error('OUTPUT_SECTION_INVALID: A contribution must contain cited content.');
    for (const row of [...section.paragraphs, ...section.tables.flatMap((table) => table.rows)]) {
      if (row.findingIds.some((id) => !findingIds.has(id))) throw new Error('OUTPUT_SECTION_INVALID: Contribution refers to a finding outside the selected run.');
    }
    if (section.tables.some((table) => table.rows.some((row) => row.cells.length !== table.columns.length))) {
      throw new Error('OUTPUT_SECTION_INVALID: Table rows must match their declared columns.');
    }
  }
  const timeline: OutputDraft['timeline'] = [];
  const uncertainTimeFindingIds: string[] = [];
  for (const finding of run.findings) {
    const time = finding.record?.time;
    if (time?.start && time.end && ['date', 'month', 'range'].includes(time.precision)) timeline.push({
      findingId: finding.id, start: time.start, end: time.end, precision: time.precision,
    });
    else uncertainTimeFindingIds.push(finding.id);
  }
  timeline.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.findingId.localeCompare(b.findingId));
  let referenceNumber = 0;
  const readIssues = outputReadIssues(run);
  return outputDraftSchema.parse({ version: 1, outputId: input.outputId, createdAt: input.createdAt,
    caseId: contents.case.id, runId: run.id, templateVersion: 'fact-draft-1',
    inputFingerprint: outputInputFingerprint(contents.case, input.state), case: contents.case,
    goal: run.goal, runStatus: run.status, runReason: run.reason,
    materials: contents.materials.map((material) => ({ materialId: material.id, label: material.sourceLabel,
      kind: material.original.kind, originalSha256: material.sha256,
      includedVersions: run.sources.filter((source) => source.materialId === material.id).map(({ versionId, textSha256 }) => ({ versionId, textSha256 })),
      availableVersionIds: input.state.materials.find((entry) => entry.materialId === material.id)!.versions.map((version) => version.versionId),
    })),
    attachments: contents.files.map((file) => ({ fileId: file.id, label: file.sourceLabel, fileName: file.fileName, sha256: file.sha256 })),
    sources: run.sources, needs: run.needs, findings: run.findings, analysis: run.information ?? null, timeline, uncertainTimeFindingIds,
    ...(run.professionalReview ? { professionalReview: run.professionalReview } : {}),
    ...(readIssues.length > 0 ? { readIssues } : {}),
    ...(input.nodeReview ? { nodeReview: input.nodeReview } : {}),
    references: run.findings.flatMap((finding) => finding.citations.map((citation) => ({ id: `R${++referenceNumber}`, findingId: finding.id, citation }))),
    sections, changes: input.previous ? changes(input.previous, run) : null,
  });
}
