import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareInformation } from '../底座/src/information/compare.ts';
import { evaluateInformationNeeds } from '../底座/src/information/coverage.ts';
import { buildNodeReview } from '../底座/src/node-review/index.ts';
import { createLaborPlugin } from '../劳动法插件/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '需求与验收案例');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (bytes) => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
const freeze = json(await readFile(join(root, 'pre-web-fixture-freeze.json')));
const inputs = {};
for (const [filename, sha] of Object.entries(freeze.files)) {
  const bytes = await readFile(join(root, filename));
  if (hash(bytes) !== sha) throw new Error('Fixture freeze mismatch: ' + filename);
  inputs[filename] = json(bytes);
}
const fixtures = inputs['pre-web-fixtures.json'].cases;
const expectations = inputs['pre-web-expectations.json'].cases;

// Manually transcribed observations from the fictional sources. These are
// model substitutes for the comparator/reviewer regression, not API answers.
const controls = {
  rephrased: { employer: '南栖商贸公司', employee: '许某', employeeId: 'N042',
    meeting: 'Q42', oral: '2026-08-03', effective: '2026-08-12', payday: '2026-08-05',
    wageMonth: '2026-07', gross: '7000', actual: '6720' },
  other_scope: { employer: '白榆公司', employee: '邵某', employeeId: 'B021',
    meeting: 'B71', oral: '2026-06-04', effective: null, payday: '2026-06-08',
    wageMonth: '2026-05', gross: '5200', actual: '4800',
    replyEmployee: '蒋某', replyEmployeeId: 'B022', replyMeeting: 'B72' },
};
const profile = createLaborPlugin().profiles[0];
const reviewer = createLaborPlugin().reviewers[0];
const ids = {
  form: 'labor.need.term-form',
  employer: 'labor.need.term.by-employer',
  date: 'labor.need.term-date',
  standard: 'labor.need.wage-standard',
  paid: 'labor.need.wage-payment',
};
const now = new Date().toISOString();
const person = (name, value) => ({ name, kind: 'person', identity: { scheme: 'employee_id', value } });
const organization = (name) => ({ name, kind: 'organization', identity: null });
const date = (value) => value ? {
  raw: value.replace(/^(\d+)-0?(\d+)-0?(\d+)$/u, '$1年$2月$3日'),
  start: value, end: value, precision: 'date',
} : { raw: null, start: null, end: null, precision: 'unknown' };
const word = (value) => ({ kind: 'text', raw: value, normalized: value, unit: null });
const money = (value) => ({ kind: 'money', raw: value + '元', normalized: value, unit: 'CNY' });
const result = [];

for (const [fixtureId, input] of Object.entries(controls)) {
  const fixture = fixtures.find((item) => item.id === fixtureId);
  const caseId = randomUUID();
  const sourceIds = Object.fromEntries([...fixture.intake, fixture.opponent, fixture.evidence].map((doc) => [doc.key, randomUUID()]));
  const versions = Object.fromEntries([...Object.keys(sourceIds), 'revised'].map((key) => [key, randomUUID()]));
  const employee = person(input.employee, input.employeeId);
  const employer = organization(input.employer);
  const checks = [];
  const expect = (name, ok, details) => checks.push({ name, ok: !!ok, ...(details === undefined ? {} : { details }) });

  async function run(stage) {
    const docs = stage === 0 ? fixture.intake : [
      ...fixture.intake.map((doc) => doc.key === fixture.revision.key ? { ...doc, text: fixture.revision.text } : doc),
      fixture.opponent, ...(stage > 1 ? [fixture.evidence] : []),
    ];
    const source = (doc) => ({
      materialId: sourceIds[doc.key],
      versionId: versions[doc.key === fixture.revision.key && stage > 0 ? 'revised' : doc.key],
      textSha256: hash(doc.text),
    });
    const sources = docs.map(source);
    const finding = (key, needId, patch) => {
      const doc = docs.find((item) => item.key === key);
      const need = profile.needs.find((item) => item.id === needId);
      const record = {
        topic: need.spec.topic, subject: employer, object: employee, attributedTo: key === 'statement' ? employee : employer,
        event: { type: 'notification', key: input.meeting, description: '口头解除通知' },
        time: date(input.oral), value: word('解除通知'), polarity: 'affirmed', period: null,
        basis: null, origin: doc.kind, qualifiers: {}, uncertainty: [], ...patch,
      };
      return {
        id: randomUUID(), needId, record, statement: doc.text,
        citations: [{ ...source(doc), start: 0, end: doc.text.length, quote: doc.text }],
      };
    };
    const findings = [
      finding('statement', ids.employer, {}),
      finding('statement', ids.form, { value: word('oral') }),
      finding('payroll', ids.standard, { event: { type: 'wage', key: null, description: '应发工资' },
        time: date(null), period: input.wageMonth, value: money(input.gross), basis: '应发' }),
      finding('payment', ids.paid, { event: { type: 'payment', key: null, description: '实际支付工资' },
        time: date(input.payday), period: input.wageMonth, value: money(input.actual), basis: '实付' }),
    ];
    if (stage >= 1) findings.push(finding('reply', ids.employer, {
      object: input.replyEmployee ? person(input.replyEmployee, input.replyEmployeeId) : employee,
      event: { type: 'notification', key: input.replyMeeting ?? input.meeting, description: '口头解除通知' },
      polarity: 'denied',
    }));
    if (stage >= 2 && input.effective) findings.push(finding('notice', ids.date, {
      event: { type: 'effective_termination', key: null, description: '书面通知明示的解除生效' },
      time: date(input.effective), value: { kind: 'date', raw: date(input.effective).raw, normalized: input.effective, unit: null },
    }));
    const attempts = profile.needs.map((need) => ({
      request: { needId: need.id, instruction: need.question, reason: need.reason },
      examined: stage === 0 && need.id === ids.date ? sources.slice(0, 1) : sources,
      findingIds: findings.filter((item) => item.needId === need.id).map((item) => item.id),
      note: '人工构造的结构化观察值',
    }));
    const comparison = compareInformation(findings);
    const analysis = { version: 1, ...comparison, needs: evaluateInformationNeeds({ needs: profile.needs,
      findings, sources, attempts, conflicts: comparison.conflicts }) };
    const goal = '核对同案材料范围和变化';
    const professionalReview = { ...(await reviewer.review({ caseId, goal, needs: profile.needs,
      findings, analysis, sources, attempts })), reviewer: { id: reviewer.id, version: reviewer.version, profileId: reviewer.profileId } };
    const providers = Object.fromEntries(['declare', 'read', 'review'].map((id) => [id, {
      capability: { id: 'fixture.' + id, version: 1 }, pluginId: 'fixture', pluginVersion: '1',
    }]));
    return { id: randomUUID(), caseId, baseCaseRevision: stage + 1, goal, createdAt: now, finishedAt: now,
      sources, providers, limits: { maxRounds: 4, maxReads: 100 }, needs: profile.needs, findings,
      rounds: [{ number: 1, attempts, review: { assessments: profile.needs.map((need) => ({
        needId: need.id, status: 'unresolved', findingIds: [], reason: '构造的复核边界',
      })), nextRequests: [], analysis, professionalReview } }],
      status: 'needs_review', reason: '模型替身业务回归', information: analysis, professionalReview };
  }

  const baseline = await run(0), answered = await run(1), evidence = await run(2);
  const create = (kind, previous, current) => buildNodeReview({ kind, baseline: previous,
    current, currentScope: current.sources });
  const answer = create('opponent_response', baseline, answered);
  const updated = create('new_evidence', answered, evidence);
  const hearing = create('hearing_preparation', evidence, evidence);
  const expected = expectations[fixtureId];
  const dateCoverage = (run) => run.information.needs.find((item) => item.needId === ids.date);
  const controversy = answered.information.conflicts.find((item) =>
    item.findingIds.every((id) => answered.findings.find((finding) => finding.id === id)?.needId === ids.employer) &&
    ['inconsistent', 'possible_conflict'].includes(item.classification));
  const wageConflict = answered.information.conflicts.some((item) =>
    item.classification === 'inconsistent' && item.findingIds.every((id) => answered.findings.find((finding) => finding.id === id)?.record?.value.kind === 'money'));
  expect('initial_missing_read_is_not_absence', dateCoverage(baseline).coverage === 'unread' && dateCoverage(baseline).unread.length > 0);
  expect('same_scope_only_conflicts', expected.opponentSameEvent
    ? !!controversy && answer.conflicts.some((item) => item.after?.evidence.length === 2 &&
      item.after.evidence.every((finding) => finding.citations.length > 0)) && answer.status === 'requires_review'
    : !controversy,
    answered.information.conflicts.map((item) => item.classification));
  expect('gross_and_actual_are_distinct_scopes', !wageConflict && answered.findings.some((item) => item.record?.value.normalized === expected.gross) &&
    answered.findings.some((item) => item.record?.value.normalized === expected.actual));
  expect('version_change_is_not_addition', answer.sources.some((item) =>
    item.kind === 'version_changed' && item.materialId === sourceIds.payroll && item.before[0].versionId === versions.payroll &&
    item.after[0].versionId === versions.revised));
  expect('opponent_source_added', answer.sources.some((item) => item.kind === 'added' && item.materialId === sourceIds.reply));
  expect('evidence_source_added', updated.sources.some((item) => item.kind === 'added' && item.materialId === sourceIds.notice));
  const beforeDate = dateCoverage(answered), afterDate = dateCoverage(evidence);
  expect('hearing_reuses_current_run', hearing.baselineRunId === evidence.id && hearing.currentRunId === evidence.id && hearing.scope.checked);
  expect('hearing_has_actionable_tasks', hearing.preparations.length > 0 && hearing.preparations.every((item) => item.instruction.trim()));
  if (expected.effectiveDate) {
    expect('explicit_effective_date_changes_coverage', beforeDate.coverage === 'not_found_in_examined' && afterDate.coverage === 'found' &&
      evidence.findings.some((item) => item.needId === ids.date && item.record?.time.start === expected.effectiveDate));
    expect('known_effective_date_is_not_reasked', !hearing.preparations.some((item) => item.kind === 'clarify' && item.needIds.includes(ids.date)));
  } else {
    expect('other_event_never_substitutes_effective_date', beforeDate.coverage === 'not_found_in_examined' &&
      afterDate.coverage === 'not_found_in_examined' && !evidence.findings.some((item) => item.needId === ids.date));
  }
  result.push({ fixture: fixtureId, checks });
}
console.log(JSON.stringify({ status: result.every((item) => item.checks.every((check) => check.ok)) ? 'passed' : 'failed',
  kind: 'synthetic structured-observation replay', fixtureHashes: freeze.files, result }, null, 2));
if (result.some((item) => item.checks.some((check) => !check.ok))) process.exitCode = 1;
