import type { InformationAnalysis, InformationFinding, InformationSource, StructuredNeed } from './contracts.ts';
import { InformationError } from './errors.ts';
import { normalizeInformationRecord } from './normalize.ts';

const key = (source: InformationSource) => `${source.materialId}/${source.versionId}/${source.textSha256}`;
function unique(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new InformationError('INFORMATION_REFERENCE_INVALID', `${label} contains duplicate IDs.`);
}
export function validateStructuredFindings(findings: readonly InformationFinding[]): void {
  unique(findings.map((item) => item.id), 'Findings');
  for (const finding of findings) {
    if (!finding.record) continue;
    const normalized = normalizeInformationRecord(finding.record, finding.citations.map((citation) => citation.quote).join('\n'));
    if (JSON.stringify(normalized) !== JSON.stringify(finding.record)) {
      throw new InformationError('INFORMATION_RECORD_NOT_NORMALIZED', 'Structured fields must be normalized from their cited raw values.');
    }
  }
}
export function validateInformationAnalysis(
  analysis: InformationAnalysis, needs: readonly StructuredNeed[], findings: readonly InformationFinding[], sources: readonly InformationSource[],
): void {
  const findingIds = new Set(findings.map((finding) => finding.id));
  const needIds = new Set(needs.map((need) => need.id));
  const sourceIds = new Set(sources.map(key));
  const conflicts = new Set(analysis.conflicts.map((conflict) => conflict.id));
  unique(analysis.entities.map((item) => item.id), 'Entity groups');
  unique(analysis.relations.map((item) => item.id), 'Relations');
  unique(analysis.conflicts.map((item) => item.id), 'Conflicts');
  unique(analysis.needs.map((item) => item.needId), 'Coverage assessments');
  if (analysis.needs.length !== needIds.size || analysis.needs.some((item) => !needIds.has(item.needId))) {
    throw new InformationError('INFORMATION_REFERENCE_INVALID', 'Coverage must describe exactly the declared needs.');
  }
  for (const item of [...analysis.entities, ...analysis.relations, ...analysis.conflicts, ...analysis.needs]) {
    unique(item.findingIds, 'Referenced findings');
    if (item.findingIds.some((id) => !findingIds.has(id))) throw new InformationError('INFORMATION_REFERENCE_INVALID', 'Analysis refers to a missing finding.');
  }
  for (const need of analysis.needs) {
    if (need.conflictIds.some((id) => !conflicts.has(id))
      || [...need.examined, ...need.unread].some((source) => !sourceIds.has(key(source)))
      || need.nextActions.some((action) => action.needId !== need.needId)) {
      throw new InformationError('INFORMATION_REFERENCE_INVALID', 'Coverage refers to an unknown conflict, source or need.');
    }
    const examined = new Set(need.examined.map(key));
    unique(need.examined.map(key), 'Examined sources'); unique(need.unread.map(key), 'Unread sources');
    if (need.unread.some((source) => examined.has(key(source))) || examined.size + need.unread.length !== sourceIds.size) {
      throw new InformationError('INFORMATION_REFERENCE_INVALID', 'Examined and unread sources must partition the selected source scope.');
    }
  }
}

export function validateInformationReview(analysis: InformationAnalysis, assessments: readonly {
  needId: string; status: string; findingIds: readonly string[];
}[]): void {
  for (const assessment of assessments) {
    const coverage = analysis.needs.find((need) => need.needId === assessment.needId);
    if (!coverage || assessment.findingIds.some((id) => !coverage.findingIds.includes(id))
      || (assessment.status === 'satisfied' && (coverage.satisfaction !== 'satisfied' || coverage.consistency !== 'consistent' || coverage.unread.length > 0))
      || (assessment.status === 'not_applicable' && coverage.satisfaction !== 'not_applicable')
      || (coverage.satisfaction === 'not_applicable' && assessment.status !== 'not_applicable')
      || (assessment.status === 'conflicting' && coverage.consistency !== 'conflicting')) {
      throw new InformationError('INFORMATION_REVIEW_INCONSISTENT', 'Professional assessment contradicts its source-backed coverage analysis.');
    }
  }
}
