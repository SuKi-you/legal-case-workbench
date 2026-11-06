import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { LoopRunStore } from '../src/loops/store.ts';
import { organizeCaseInformation } from '../src/information/service.ts';
import { createDeepSeekModel, loadDeepSeekConfig } from '../src/information/deepseek.ts';
import type { LoopFinding, LoopRun } from '../src/loops/contracts.ts';
import type { InformationEntity } from '../src/information/contracts.ts';
import type { JsonModel } from '../src/information/model.ts';
import { acceptanceCases, type InformationAcceptanceCase, type InformationAcceptanceFact } from './fixtures/information-acceptance.ts';

const sourcePair = (a: number, b: number) => [a, b].sort((left, right) => left - right).join('/');
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((value) => b.has(value));
function sameEntity(a: InformationEntity | null, b: InformationEntity | null): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name && a.kind === b.kind && (a.identity === null || b.identity === null
    ? a.identity === b.identity : a.identity.scheme === b.identity.scheme && a.identity.value === b.identity.value);
}
function matchesFact(finding: LoopFinding, fact: InformationAcceptanceFact, fixture: InformationAcceptanceCase): boolean {
  const record = finding.record;
  if (!record) return false;
  const value = record.value, time = record.time;
  return finding.needId === fact.needId && record.topic === fact.topic && record.event.type === fact.topic
    && sameEntity(record.subject, fact.subject) && sameEntity(record.object, fact.object) && sameEntity(record.attributedTo, fact.attributedTo)
    && record.event.key === fact.eventKey && record.period === fact.period && record.basis === fact.basis
    && record.origin === fixture.materials[fact.sourceIndex]?.kind && record.polarity === fact.polarity
    && value.kind === fact.value.kind && value.unit === fact.value.unit
    && (fact.value.normalized === undefined ? value.normalized === value.raw : value.normalized === fact.value.normalized)
    && value.raw !== null && fact.value.rawIncludes.every((raw) => value.raw!.includes(raw))
    && !(fact.value.rawExcludes ?? []).some((raw) => value.raw!.includes(raw))
    && finding.citations.some((citation) => citation.quote.includes(value.raw!))
    && fact.time.allowedRanges.some((range) => range.precision === time.precision && range.start === time.start && range.end === time.end)
    && (!fact.time.rawMustBeNull || time.raw === null)
    && (fact.time.rawIncludes ?? []).every((raw) => time.raw?.includes(raw))
    && !(fact.time.rawExcludes ?? []).some((raw) => time.raw?.includes(raw));
}

export function gradeInformationAcceptance(fixture: InformationAcceptanceCase, run: LoopRun) {
  const analysis = run.information;
  // Identify fixture sources by content, independently of selection or finding order.
  const hashes = fixture.materials.map((material) => createHash('sha256').update(material.text).digest('hex'));
  const sourceScopeMatches = run.sources.length === hashes.length && new Set(run.sources.map((source) => source.materialId)).size === hashes.length
    && JSON.stringify(run.sources.map((source) => source.textSha256).sort()) === JSON.stringify([...hashes].sort());
  const sourceByMaterial = new Map(run.sources.map((source) => [source.materialId, source]));
  const findingSources = new Map<string, number>();
  const factMatches = new Map<string, InformationAcceptanceFact[]>();
  const citationsValid = run.findings.every((finding) => finding.citations.length > 0 && finding.citations.every((citation) => {
    const source = sourceByMaterial.get(citation.materialId), index = source ? hashes.indexOf(source.textSha256) : -1;
    const text = fixture.materials[index]?.text;
    return source !== undefined && text !== undefined && citation.versionId === source.versionId && citation.textSha256 === source.textSha256
      && Number.isInteger(citation.start) && Number.isInteger(citation.end) && citation.start >= 0 && citation.end > citation.start
      && citation.end <= text.length && text.slice(citation.start, citation.end) === citation.quote;
  }));
  for (const finding of run.findings) {
    const indices = new Set(finding.citations.map((citation) => hashes.indexOf(citation.textSha256)));
    const index = indices.size === 1 ? [...indices][0]! : -1;
    if (index >= 0) findingSources.set(finding.id, index);
    factMatches.set(finding.id, fixture.expected.facts.filter((fact) => index === fact.sourceIndex && matchesFact(finding, fact, fixture)));
  }
  const unmatchedFindingIds = run.findings.filter((finding) => factMatches.get(finding.id)!.length === 0).map((finding) => finding.id);
  const coveredFactIds = new Set([...factMatches.values()].flatMap((matches) => matches.map((fact) => fact.id)));
  const missingExpectedFacts = fixture.expected.facts.filter((fact) => !coveredFactIds.has(fact.id)).map((fact) => fact.id);
  const sourceFactsMatch = sourceScopeMatches && citationsValid && new Set(run.findings.map((finding) => finding.id)).size === run.findings.length
    && unmatchedFindingIds.length === 0 && missingExpectedFacts.length === 0;
  const values = [...new Set(run.findings.flatMap((finding) => finding.record?.value.kind === 'money' && finding.record.value.normalized !== null
    ? [finding.record.value.normalized] : []))].sort();
  const actualPairs = new Set<string>();
  let conflictFieldsValid = true;
  for (const conflict of analysis?.conflicts ?? []) {
    if (conflict.classification !== 'inconsistent') continue;
    const [a, b] = conflict.findingIds.map((id) => findingSources.get(id));
    if (conflict.field !== 'value' || a === undefined || b === undefined || a === b
      || conflict.findingIds.some((id) => run.findings.find((finding) => finding.id === id)?.record?.value.kind !== 'money')) {
      conflictFieldsValid = false; continue;
    }
    actualPairs.add(sourcePair(a, b));
  }
  const expectedPairs = new Set(fixture.expected.inconsistentSourcePairs.map(([a, b]) => sourcePair(a, b)));
  const inconsistentPairsMatch = analysis !== undefined && conflictFieldsValid && sameSet(actualPairs, expectedPairs);
  const equivalentRelations = analysis?.relations.filter((relation) => relation.kind === 'equivalent_claim' && relation.status === 'confirmed') ?? [];
  const allowedEquivalentPairs = new Set(fixture.expected.equivalentSourcePairs.map(([a, b]) => sourcePair(a, b)));
  const equivalentClaimsValid = equivalentRelations.every((relation) => relation.findingIds.every((left, index) => relation.findingIds.slice(index + 1).every((right) => {
    const a = findingSources.get(left), b = findingSources.get(right);
    return a !== undefined && b !== undefined && a !== b && allowedEquivalentPairs.has(sourcePair(a, b));
  })));
  const separatedSubjects = (fixture.expected.separateSubjectSources ?? []).every(([a, b]) => {
    const joins = (ids: string[]) => ids.some((id) => findingSources.get(id) === a) && ids.some((id) => findingSources.get(id) === b);
    return !analysis?.entities.some((group) => joins(group.findingIds))
      && !analysis?.relations.some((relation) => relation.status === 'confirmed'
        && ['same_entity', 'same_event', 'equivalent_claim'].includes(relation.kind) && joins(relation.findingIds));
  });
  const expectedConflictNeeds = new Set(fixture.expected.inconsistentSourcePairs.flatMap(([a, b]) => fixture.expected.facts
    .filter((fact) => fact.sourceIndex === a || fact.sourceIndex === b).map((fact) => fact.needId)));
  const sourceKey = (source: LoopRun['sources'][number]) => `${source.materialId}/${source.versionId}/${source.textSha256}`;
  const allSourceKeys = new Set(run.sources.map(sourceKey));
  const coverageMatches = analysis?.needs.length === fixture.needs.length && fixture.needs.every((need) => {
    const coverage = analysis.needs.find((item) => item.needId === need.id);
    const expectedFindingIds = new Set(run.findings.filter((finding) => finding.needId === need.id).map((finding) => finding.id));
    const conflicting = expectedConflictNeeds.has(need.id);
    return coverage !== undefined && sameSet(new Set(coverage.findingIds), expectedFindingIds)
      && sameSet(new Set(coverage.examined.map(sourceKey)), allSourceKeys) && coverage.unread.length === 0
      && coverage.consistency === (conflicting ? 'conflicting' : 'consistent')
      && coverage.satisfaction === (conflicting ? 'needs_review' : 'satisfied');
  }) && run.status === (expectedPairs.size > 0 ? 'needs_review' : 'completed');
  const relative = !fixture.expected.relativeTimeMustStayUnknown || run.findings.every((finding) => finding.record
    && finding.record.time.start === null && finding.record.time.end === null)
      && coveredFactIds.has('oral-0');
  const preservedDenial = !fixture.expected.relativeTimeMustStayUnknown || coveredFactIds.has('subsequent-contact-1');
  const noRepeatedQuestion = !fixture.expected.relativeTimeMustStayUnknown || (analysis?.needs.length === fixture.needs.length
    && fixture.needs.every((expectedNeed) => analysis.needs.some((need) => need.needId === expectedNeed.id && need.findingIds.length > 0
      && need.findingIds.every((id) => (factMatches.get(id) ?? []).some((fact) => fact.needId === need.needId))
      && need.satisfaction === 'satisfied' && need.unread.length === 0 && !need.nextActions.some((action) => action.kind === 'clarify'))));
  const valueMatch = JSON.stringify(values) === JSON.stringify([...fixture.expected.expectedAmounts].sort());
  return {
    passed: sourceFactsMatch && inconsistentPairsMatch && equivalentRelations.length >= fixture.expected.minEquivalentClaims
      && equivalentClaimsValid && separatedSubjects && coverageMatches && valueMatch && relative && preservedDenial && noRepeatedQuestion,
    sourceFactsMatch, unmatchedFindingIds, missingExpectedFacts, sourceScopeMatches, citationsValid,
    amountValuesMatch: valueMatch, inconsistentSourcePairs: actualPairs.size, expectedInconsistentSourcePairs: expectedPairs.size,
    inconsistentSourcePairsMatch: inconsistentPairsMatch, actualSourcePairs: [...actualPairs].sort(), expectedSourcePairs: [...expectedPairs].sort(),
    equivalentClaims: equivalentRelations.length, minimumEquivalentClaims: fixture.expected.minEquivalentClaims, equivalentClaimsValid,
    subjectSeparationPreserved: separatedSubjects,
    coverageAndStatusMatch: coverageMatches,
    relativeTimePreserved: relative, denialPreserved: preservedDenial, avoidsRepeatedQuestions: noRepeatedQuestion,
  };
}

export async function runInformationAcceptance(args: string[]) {
  const { values } = parseArgs({ args, options: {
    'data-dir': { type: 'string', default: './runtime-data' }, scenario: { type: 'string', default: 'all' },
  } });
  const dataDir = resolve(values['data-dir']);
  const fixtures = acceptanceCases.filter((fixture) => values.scenario === 'all' || fixture.id === values.scenario);
  if (fixtures.length === 0) throw new Error('未知验收场景。');
  const model = createDeepSeekModel(loadDeepSeekConfig());
  const cases = new CaseStore(dataDir), workspace = new CaseWorkspace(dataDir, cases);
  const results: unknown[] = [];
  let failures = 0;
  console.log(`使用 ${model.model} 读取 ${fixtures.length} 组独立虚构材料；验收标准保留在评分侧，不传给模型。`);
  for (const fixture of fixtures) {
    const record = await cases.create({ title: `虚构模型验收：${fixture.title}`, actor: '独立材料验收' });
    const selections: { materialId: string; versionId: string }[] = [];
    const sourceKinds: Record<string, 'party_statement' | 'document_record'> = {};
    for (const material of fixture.materials) {
      const stored = await workspace.registerText({ caseId: record.id, sourceLabel: material.sourceLabel, text: material.text });
      selections.push({ materialId: stored.id, versionId: stored.id }); sourceKinds[stored.id] = material.kind;
    }
    let modelCalls = 0;
    const counted: JsonModel = { id: model.id, model: model.model, complete: (input) => { modelCalls += 1; return model.complete(input); } };
    console.log(`开始：${fixture.title}`);
    try {
      const run = await organizeCaseInformation({ dataDir, caseId: record.id, model: counted, plan: {
        goal: fixture.goal, selections, sourceKinds, needs: fixture.needs,
        limits: { maxRounds: 8, maxReads: 16 }, maxModelCalls: 24,
      } });
      const restored = await new LoopRunStore(dataDir).read({ caseId: record.id, runId: run.id });
      const grade = gradeInformationAcceptance(fixture, restored);
      const result = { scenario: fixture.id, caseId: record.id, runId: run.id, status: run.status,
        rounds: run.rounds.length, recordCount: run.findings.length, modelCalls, ...grade };
      results.push(result); if (!grade.passed) failures += 1;
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      failures += 1;
      const result = { scenario: fixture.id, caseId: record.id, passed: false, modelCalls, error: error instanceof Error ? error.message : '验收失败' };
      results.push(result); console.log(JSON.stringify(result));
    }
  }
  const report = { checkedAt: new Date().toISOString(), provider: model.id, model: model.model,
    syntheticMaterialsOnly: true, expectedNotSentToModel: true, passed: failures === 0, results };
  const directory = join(dataDir, 'evaluations'); await mkdir(directory, { recursive: true });
  const reportPath = join(directory, `information-${randomUUID()}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(`验收记录：${reportPath}`);
  if (failures > 0) process.exitCode = 1;
  return report;
}
if (import.meta.main) {
  try { await runInformationAcceptance(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : '模型验收失败'); process.exitCode = 1; }
}
