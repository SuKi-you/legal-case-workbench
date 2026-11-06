import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const fixturesDir = join(project, '需求与验收案例');
const foundation = join(project, '底座');
const plugin = join(project, '劳动法插件', 'src', 'index.ts');
const reportsRoot = resolve(project, '..', '..', '对照评测', 'pre-web');
const { values } = parseArgs({ options: {
  live: { type: 'boolean' },
  fixture: { type: 'string', default: 'primary' },
  'model-calls': { type: 'string', default: '100' },
  'source-kinds': { type: 'boolean' },
  'natural-language-smoke': { type: 'boolean' },
  'resume-intake-report': { type: 'string' },
  'clone-intake-from': { type: 'string' },
  'through-opponent': { type: 'boolean' },
} });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const parse = (bytes) => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
const readJson = async (path) => parse(await readFile(path));
const freeze = await readJson(join(fixturesDir, 'pre-web-fixture-freeze.json'));
const files = {};
for (const name of ['pre-web-fixtures.json', 'pre-web-expectations.json']) {
  const bytes = await readFile(join(fixturesDir, name));
  if (sha256(bytes) !== freeze.files[name]) throw new Error('Fixture freeze mismatch: ' + name);
  files[name] = parse(bytes);
}
const fixture = files['pre-web-fixtures.json'].cases.find((item) => item.id === values.fixture);
const expectation = files['pre-web-expectations.json'].cases[values.fixture];
if (!fixture || !expectation) throw new Error('Unknown frozen fixture: ' + values.fixture);
const from = (name) => import(pathToFileURL(join(foundation, 'src', name)).href);
if (values['clone-intake-from']) {
  if (values.live || values['resume-intake-report']) throw new Error('Cloning is an offline preparation step.');
  const originalPath = resolve(values['clone-intake-from']);
  if (dirname(dirname(originalPath)) !== reportsRoot || basename(originalPath) !== 'result.json')
    throw new Error('Choose a saved pre-web result.json.');
  const original = await readJson(originalPath);
  const intake = original.stages?.[0];
  if (!['passed', 'checks_failed'].includes(original.status) || original.fixture !== fixture.id
    || JSON.stringify(original.fixtureHashes) !== JSON.stringify(freeze.files)
    || intake?.kind !== 'intake' || intake.result?.taskStatus !== 'completed' || !original.intakeCheckpointId
    || !/^[a-f0-9-]{36}$/u.test(original.caseId))
    throw new Error('Source report does not identify a completed synthetic intake and its saved checkpoint.');
  const physicalTemp = await realpath(tmpdir());
  const sourceDir = await realpath(original.dataDir);
  if (dirname(sourceDir) !== physicalTemp || !basename(sourceDir).startsWith('law-pre-web-'))
    throw new Error('Source workspace is not an isolated synthetic temp workspace.');
  const sourceCase = join(sourceDir, 'cases', original.caseId);
  if (await realpath(sourceCase) !== sourceCase) throw new Error('Source case path must not be redirected.');
  const { CaseStore } = await from('cases/store.ts');
  const { CaseWorkspace } = await from('cases/workspace.ts');
  const { CaseRollback } = await from('cases/rollback.ts');
  const { readCaseOutput } = await from('outputs/store.ts');
  const sourceCaseRecord = await new CaseStore(sourceDir).read(original.caseId);
  if (sourceCaseRecord.title !== fixture.title) throw new Error('Source case title differs from frozen synthetic fixture.');
  const cloneDir = await mkdtemp(join(physicalTemp, 'law-pre-web-'));
  await cp(sourceCase, join(cloneDir, 'cases', original.caseId), { recursive: true, force: false, errorOnExist: true,
    filter: async path => {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Synthetic case copy must not contain symbolic links.');
      return true;
    },
  });
  const cases = new CaseStore(cloneDir), workspace = new CaseWorkspace(cloneDir, cases);
  const rollback = new CaseRollback(cases, workspace);
  const preview = await rollback.preview({ caseId: original.caseId, checkpointId: original.intakeCheckpointId });
  await rollback.apply({ caseId: original.caseId, checkpointId: original.intakeCheckpointId,
    expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '验收克隆恢复' });
  const saved = await readCaseOutput({ dataDir: cloneDir, caseId: original.caseId, outputId: intake.result.outputId });
  if (saved.draft.runId !== intake.result.runId) throw new Error('Cloned intake run differs from its saved report.');
  const folder = await mkdtemp(join(reportsRoot, fixture.id + '-clone-'));
  const resumeReport = join(folder, 'resume-intake.json');
  await writeFile(resumeReport, JSON.stringify({
    schema: 1, fixture: fixture.id, fixtureHashes: freeze.files, dataDir: cloneDir, caseId: original.caseId,
    clonedFrom: originalPath, intakeCheckpointId: original.intakeCheckpointId,
    stages: [{ ...intake, result: { ...intake.result, paths: saved.paths },
      output: { ...intake.output, paths: saved.paths } }],
  }, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ resumeIntakeReport: resumeReport, dataDir: cloneDir, intakeOutputId: saved.draft.outputId }));
  process.exit(0);
}
if (!values.live) {
  console.log(JSON.stringify({ verified: true, fixture: fixture.id, files: freeze.files, live: false }));
  process.exit(0);
}
if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('Live evaluation requires local DeepSeek configuration.');
if (!/^[1-9][0-9]*$/u.test(values['model-calls']) || Number(values['model-calls']) > 200) {
  throw new Error('Use a positive per-task model budget of at most 200.');
}

const { CaseStore } = await from('cases/store.ts');
const { CaseWorkspace } = await from('cases/workspace.ts');
const { CaseRollback } = await from('cases/rollback.ts');
const { ExecutionStore } = await from('execution/store.ts');
const { readCaseOutput, listCaseOutputs } = await from('outputs/store.ts');
const resumePath = values['resume-intake-report'] ? resolve(values['resume-intake-report']) : undefined;
const prior = resumePath ? await readJson(resumePath) : undefined;
if (values['through-opponent'] && !prior) throw new Error('Targeted opponent recheck requires a saved intake.');
if (prior && (dirname(dirname(resumePath)) !== reportsRoot || prior.fixture !== fixture.id
  || prior.stages?.length !== 1 || prior.stages[0].kind !== 'intake' || prior.stages[0].result?.taskStatus !== 'completed'
  || JSON.stringify(prior.fixtureHashes) !== JSON.stringify(freeze.files)
  || dirname(resolve(prior.dataDir)) !== resolve(tmpdir()) || !resolve(prior.dataDir).split(/[\\/]/u).at(-1)?.startsWith('law-pre-web-'))) {
  throw new Error('Resume requires a completed intake from this frozen synthetic fixture and its isolated workspace.');
}
const dataDir = prior?.dataDir ?? await mkdtemp(join(tmpdir(), 'law-pre-web-'));
await mkdir(reportsRoot, { recursive: true });
const runDir = await mkdtemp(join(reportsRoot, fixture.id + '-'));
const reportPath = join(runDir, 'result.json');
const cases = new CaseStore(dataDir);
const workspace = new CaseWorkspace(dataDir, cases);
const rollback = new CaseRollback(cases, workspace);
const actor = '独立业务验收';
const report = {
  schema: 1,
  fixture: fixture.id,
  fixtureHashes: freeze.files,
  modelBudgetPerWorkflow: Number(values['model-calls']),
  sourceKindsSupplied: !!values['source-kinds'],
  dataDir,
  startedAt: new Date().toISOString(),
  status: 'running',
  stages: [],
  assertions: [],
  ...(values['through-opponent'] ? { through: 'opponent_response' } : {}),
};
const saveReport = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
const secrets = [process.env.DEEPSEEK_API_KEY].filter(Boolean);
const scrub = (text) => secrets.reduce((clean, token) => clean.replaceAll(token, '<redacted>'), text);
const check = (name, ok, evidence) => report.assertions.push({ name, ok: !!ok, ...(evidence === undefined ? {} : { evidence }) });
const docs = new Map();
let caseId;

async function seed(doc) {
  const material = await workspace.registerText({ caseId, sourceLabel: doc.label, text: doc.text });
  const versions = await workspace.listVersions({ caseId, materialId: material.id });
  if (versions.length !== 1) throw new Error('New fixture material must have exactly one text version.');
  docs.set(doc.key, { materialId: material.id, versionId: versions[0].id, textSha256: versions[0].textSha256, kind: doc.kind });
}

async function child(name, entry, args) {
  const started = Date.now();
  console.log('开始 ' + name);
  const processChild = spawn(process.execPath, [join(foundation, 'examples', entry), ...args], {
    cwd: foundation,
    env: { ...process.env, DEEPSEEK_TIMEOUT_MS: process.env.DEEPSEEK_TIMEOUT_MS || '180000' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '', err = '';
  processChild.stdout.setEncoding('utf8').on('data', (part) => { out += part; });
  processChild.stderr.setEncoding('utf8').on('data', (part) => { err += part; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; processChild.kill(); }, 1_200_000);
  let outcome;
  try {
    outcome = await new Promise((done, reject) => {
      processChild.once('error', reject);
      processChild.once('close', (exitCode, signal) => done({ exitCode, signal }));
    });
  } finally {
    clearTimeout(timer);
  }
  const stdout = scrub(out), stderr = scrub(err);
  await writeFile(join(runDir, name + '.log'), stdout + '\n' + stderr, 'utf8');
  return { ...outcome, timedOut, elapsedMs: Date.now() - started, stdout };
}

const commonArgs = () => ['--data-dir', dataDir, '--case', caseId];
const cited = (finding, key) => finding.citations.some((ref) => ref.materialId === docs.get(key)?.materialId);
const byNeed = (draft, id) => draft.findings.filter((item) => item.needId === id);
const employerNeed = 'labor.need.term.by-employer';
const dateNeed = 'labor.need.term-date';
const formNeed = 'labor.need.term-form';

function ownDate(raw) {
  if (!raw) return null;
  const match = /^(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?$/u.exec(raw.trim());
  return match ? match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0') : null;
}
function dateFindings(draft) {
  return byNeed(draft, dateNeed).filter((item) => item.record?.polarity === 'affirmed');
}
function datesFor(finding) {
  const record = finding.record;
  return [record.time.start, record.time.raw, ...(record.value.kind === 'date' ? [record.value.raw, record.value.normalized] : [])]
    .map(ownDate).filter(Boolean);
}

async function citationCheck(draft) {
  const versions = new Map();
  const references = [...draft.findings.flatMap((finding) => finding.citations), ...draft.references.map((item) => item.citation)];
  async function verify(ref, requireCurrentSource) {
    const key = ref.materialId + '/' + ref.versionId;
    if (!versions.has(key)) {
      const { version } = await workspace.readVersion({ caseId, materialId: ref.materialId, versionId: ref.versionId });
      versions.set(key, version);
    }
    const version = versions.get(key);
    return version.textSha256 === ref.textSha256 && sha256(version.text) === ref.textSha256 &&
      version.text.slice(ref.start, ref.end) === ref.quote &&
      (!requireCurrentSource || draft.sources.some((source) => source.materialId === ref.materialId &&
        source.versionId === ref.versionId && source.textSha256 === ref.textSha256));
  }
  for (const ref of references) if (!await verify(ref, true)) return false;
  const node = draft.nodeReview;
  if (node) {
    const pairs = [
      ...node.facts.map((item) => [item.before, item.after]),
      ...node.conflicts.map((item) => [item.before?.evidence ?? [], item.after?.evidence ?? []]),
      ...node.professional.changes.map((item) => [item.before?.evidence ?? [], item.after?.evidence ?? []]),
    ];
    for (const [before, after] of pairs) {
      for (const item of before) for (const ref of item.citations) if (!await verify(ref, false)) return false;
      for (const item of after) for (const ref of item.citations) if (!await verify(ref, true)) return false;
    }
  }
  return references.length > 0;
}

function noFalseWageConflict(draft) {
  const findings = new Map(draft.findings.map((item) => [item.id, item]));
  return !draft.analysis?.conflicts.some((conflict) => {
    if (conflict.classification !== 'inconsistent') return false;
    const pair = conflict.findingIds.map((id) => findings.get(id));
    return pair.every((item) => item?.record?.value.kind === 'money') &&
      pair.some((item) => cited(item, 'payroll')) && pair.some((item) => cited(item, 'payment'));
  });
}

async function workflow(kind, { previous, currentRunId } = {}) {
  const previousOutputId = previous?.outputId;
  const opts = [...commonArgs(), '--plugin', plugin, '--workflow', kind, '--profile', 'labor.intake', '--model-calls', values['model-calls']];
  if (!currentRunId) {
    for (const doc of docs.values()) {
      opts.push('--select', doc.materialId + '=' + doc.versionId);
      if (values['source-kinds']) opts.push('--source-kind', doc.materialId + '=' + doc.kind);
    }
  }
  if (previousOutputId) opts.push('--previous-output', previousOutputId);
  if (currentRunId) opts.push('--run', currentRunId);
  let stage;
  if (prior && kind === 'intake') {
    stage = { ...prior.stages[0], reusedFromReport: resumePath };
  } else {
    const executed = await child(kind, 'agent.ts', opts);
    const line = executed.stdout.split(/\r?\n/u).findLast((entry) => entry.startsWith('WORKFLOW_RESULT '));
    stage = { kind, ...executed, stdout: undefined, result: line ? JSON.parse(line.slice('WORKFLOW_RESULT '.length)) : undefined };
  }
  const { result, exitCode } = stage;
  report.stages.push(stage);
  await saveReport();
  if (!result?.outputId || !result?.runId) throw new Error(kind + ' did not produce a saved output. See ' + join(runDir, kind + '.log'));
  const saved = await readCaseOutput({ dataDir, caseId, outputId: result.outputId });
  const { draft } = saved;
  const expectedPairCount = docs.size * draft.needs.length;
  const counts = draft.analysis?.needs.reduce((state, item) => {
    state.examined += item.examined.length;
    state.unread += item.unread.length;
    if (item.unread.length && item.coverage === 'not_found_in_examined') state.falseAbsence += 1;
    return state;
  }, { examined: 0, unread: 0, falseAbsence: 0 });
  const versions = [...docs.values()].every((doc) =>
    draft.sources.some((source) => source.materialId === doc.materialId && source.versionId === doc.versionId && source.textSha256 === doc.textSha256));
  const outputs = await Promise.all(Object.values(saved.paths).map(path => readFile(path)));
  check(kind + '.workflow_completed', exitCode === 0 && result.taskStatus === 'completed', result.taskStatus);
  check(kind + '.same_case_same_run', draft.caseId === caseId && draft.runId === result.runId);
  check(kind + '.selected_versions', versions && draft.sources.length === docs.size && saved.currentInputMatches);
  check(kind + '.tri_format_integrity', outputs.every((bytes) => bytes.length > 0) && outputs[2]?.subarray(0, 2).toString() === 'PK');
  check(kind + '.citations_match', await citationCheck(draft));
  check(kind + '.professional_review', draft.professionalReview?.reviewer.profileId === 'labor.intake' && draft.professionalReview.assessments.length > 0);
  check(kind + '.coverage_ledger', counts && counts.examined + counts.unread === expectedPairCount && counts.falseAbsence === 0, counts);
  check(kind + '.incomplete_coverage_reported', counts && (counts.unread === 0 || (
    result.coverage?.unreadPairs === counts.unread && draft.runStatus !== 'completed' &&
    draft.nodeReview?.status !== 'ready_for_review'
  )));
  check(kind + '.wage_scope', noFalseWageConflict(draft));
  check(kind + '.no_substitute_effective_date', dateFindings(draft).every((finding) =>
    datesFor(finding).every((date) => !expectation.notEffectiveDates.includes(date))));
  if (previousOutputId) {
    check(kind + '.output_lineage', saved.manifest.previousOutputId === previousOutputId && draft.changes?.previousOutputId === previousOutputId);
    const node = draft.nodeReview;
    check(kind + '.node_lineage', node?.kind === kind && node.caseId === caseId &&
      node.baselineRunId === previous.runId && node.currentRunId === draft.runId);
    check(kind + '.node_scope', node?.scope.checked === true &&
      node.scope.missingSources.length === 0 && node.scope.unexpectedSources.length === 0);
    const currentIds = new Set(draft.findings.map((item) => item.id));
    const baselineIds = new Set(previous.findings.map((item) => item.id));
    check(kind + '.preparation_references', node?.preparations.length > 0 && node.preparations.every((item) =>
      item.instruction.trim() && item.reason.trim() &&
      item.currentFindingIds.every((id) => currentIds.has(id)) &&
      item.baselineFindingIds.every((id) => baselineIds.has(id))));
  }
  if (currentRunId) check(kind + '.review_reuses_current_run', draft.runId === currentRunId);
  stage.coverage = counts;
  stage.output = { outputId: draft.outputId, runId: draft.runId, paths: saved.paths, currentInputMatches: saved.currentInputMatches };
  stage.modelCalls = result.modelCalls ?? result.usedModelCalls;
  if (result.sessionId) {
    const snapshots = await new ExecutionStore(dataDir).list(caseId);
    const state = snapshots.find((item) => item.snapshot.payload.id === result.sessionId)?.snapshot.payload;
    stage.modelCalls ??= state?.tasks?.find((item) => item.id === result.taskId)?.usedModelCalls;
  }
  await saveReport();
  return { saved, result, draft };
}

function moneyObserved(draft, amount, key) {
  return draft.findings.some((item) => cited(item, key) && item.record?.value.kind === 'money' &&
    item.record.value.normalized && Number(item.record.value.normalized) === Number(amount));
}
function checkOpposition(draft) {
  const findings = new Map(draft.findings.map((item) => [item.id, item]));
  const own = byNeed(draft, employerNeed).some((item) => item.record?.polarity === 'affirmed' && cited(item, 'statement'));
  const denial = byNeed(draft, employerNeed).some((item) => item.record?.polarity === 'denied' && cited(item, 'reply'));
  const allegedConflict = draft.analysis?.conflicts.some((conflict) =>
    ['inconsistent', 'possible_conflict'].includes(conflict.classification) &&
    conflict.findingIds.some((id) => findings.has(id) && cited(findings.get(id), 'statement')) &&
    conflict.findingIds.some((id) => findings.has(id) && cited(findings.get(id), 'reply')));
  if (!expectation.opponentSameEvent) {
    check('opponent_response.no_false_conflict', own && !allegedConflict, { own, allegedConflict });
    return;
  }
  const state = draft.professionalReview?.assessments.find((item) => item.checkId === 'labor.termination.by-employer')?.state;
  check('opponent_response.both_sides_retained', own && denial, { own, denial });
  check('opponent_response.dispute_pending', (allegedConflict || ['unresolved', 'conflicting'].includes(state)) && own && denial, { allegedConflict, state });
}

run: try {
  const record = prior ? await cases.read(prior.caseId)
    : await cases.create({ title: fixture.title, actor, description: '纯虚构材料，仅用于本地 CLI 业务验收。' });
  caseId = record.id;
  report.caseId = caseId;
  await saveReport();
  if (prior) {
    const contents = await workspace.contents(caseId);
    if (record.title !== fixture.title || contents.materials.length !== fixture.intake.length || contents.files.length > 0)
      throw new Error('Existing case differs from the isolated intake fixture.');
    for (const doc of fixture.intake) {
      const matches = contents.materials.filter(item => item.sourceLabel === doc.label);
      if (matches.length !== 1) throw new Error('Cannot identify frozen source ' + doc.key);
      const materialId = matches[0].id;
      const versions = await workspace.listVersions({ caseId, materialId });
      if (versions.length !== 1) throw new Error('Unexpected version count in saved intake.');
      const { id: versionId, textSha256 } = versions[0];
      const view = await workspace.readVersion({ caseId, materialId, versionId });
      if (view.version.text !== doc.text) throw new Error('Frozen source text changed.');
      docs.set(doc.key, { materialId, versionId, textSha256, kind: doc.kind });
    }
  } else {
    for (const doc of fixture.intake) await seed(doc);
  }
  const first = await workflow('intake');
  check('intake.declared_28_needs', first.draft.needs.length === 28);
  const oral = byNeed(first.draft, formNeed).some((item) => cited(item, 'statement') &&
    item.citations.some((ref) => /口头|当面/u.test(ref.quote)));
  check('intake.known_oral_preserved', oral);
  check('intake.no_reask_known_oral_form', oral &&
    !first.draft.professionalReview?.actions.some((action) => action.kind === 'clarify' && action.needId === formNeed));
  check('intake.effective_date_unknown', dateFindings(first.draft).every((finding) => datesFor(finding).length === 0));
  check('intake.both_wage_amounts_observed', moneyObserved(first.draft, expectation.gross, 'payroll') && moneyObserved(first.draft, expectation.actual, 'payment'));
  const intakePoint = await rollback.createCheckpoint({ caseId, actor, label: '独立验收：接案完成' });
  report.intakeCheckpointId = intakePoint.id;
  await saveReport();

  const before = docs.get(fixture.revision.key);
  const oldText = (await workspace.readVersion({ caseId, materialId: before.materialId, versionId: before.versionId })).version.text;
  const after = await workspace.saveRevision({ caseId, materialId: before.materialId, baseVersionId: before.versionId,
    baseTextSha256: before.textSha256, editor: actor, text: fixture.revision.text, note: fixture.revision.note });
  docs.set(fixture.revision.key, { ...before, versionId: after.id, textSha256: after.textSha256 });
  const history = await workspace.readVersion({ caseId, materialId: before.materialId, versionId: before.versionId });
  check('revision.old_text_immutable', oldText.includes(expectation.revisionReplaces[0]) &&
    history.version.text === oldText && after.text.includes(expectation.revisionReplaces[1]) && after.id !== before.versionId);
  await seed(fixture.opponent);
  const answer = await workflow('opponent_response', { previous: first.draft });
  check('opponent_response.revision_visible', first.draft.sources.some((item) => item.versionId === before.versionId) &&
    answer.draft.sources.some((item) => item.versionId === after.id) &&
    !answer.draft.sources.some((item) => item.versionId === before.versionId) &&
    answer.draft.nodeReview?.sources.some((item) => item.materialId === before.materialId && item.kind === 'version_changed' &&
      item.before.some((source) => source.versionId === before.versionId) &&
      item.after.some((source) => source.versionId === after.id)));
  check('opponent_response.added_reply', answer.draft.nodeReview?.sources.some((item) =>
    item.kind === 'added' && item.materialId === docs.get('reply').materialId));
  checkOpposition(answer.draft);
  if (values['through-opponent']) {
    report.status = report.assertions.every(item => item.ok) ? 'passed' : 'checks_failed';
    break run;
  }
  await seed(fixture.evidence);
  const evidence = await workflow('new_evidence', { previous: answer.draft });
  check('new_evidence.added_source', evidence.draft.nodeReview?.sources.some((item) =>
    item.kind === 'added' && item.materialId === docs.get('notice').materialId));
  const explicit = dateFindings(evidence.draft).filter((finding) => cited(finding, 'notice')).flatMap(datesFor);
  check('new_evidence.effective_date_updated', expectation.effectiveDate === null ?
    dateFindings(evidence.draft).every((finding) => datesFor(finding).length === 0) : explicit.includes(expectation.effectiveDate), explicit);
  const hearing = await workflow('hearing_preparation', { previous: evidence.draft, currentRunId: evidence.draft.runId });
  const dateClarification = (draft) => draft.nodeReview?.preparations.some((item) => item.kind === 'clarify' && item.needIds.includes(dateNeed));
  check('hearing_preparation.updated_date_check', expectation.effectiveDate === null ?
    dateFindings(hearing.draft).every((finding) => datesFor(finding).length === 0) :
    explicit.includes(expectation.effectiveDate) && !dateClarification(hearing.draft));

  const laterOutputIds = [answer.draft.outputId, evidence.draft.outputId, hearing.draft.outputId];
  const preview = await rollback.preview({ caseId, checkpointId: intakePoint.id });
  check('rollback.preview_lists_subsequent_outputs', laterOutputIds.every((id) => preview.outputsLeaving?.includes(id)));
  const restored = await rollback.apply({ caseId, checkpointId: intakePoint.id, expectedRevision: preview.expectedRevision, previewToken: preview.token, actor });
  const afterRollback = await listCaseOutputs({ dataDir, caseId });
  check('rollback.future_outputs_hidden', afterRollback.length === 1 && afterRollback[0].outputId === first.draft.outputId);
  check('rollback.historical_bytes_retained', (await readFile(hearing.saved.paths.json)).length > 0);
  const undo = await rollback.preview({ caseId, checkpointId: restored.undoCheckpoint.id });
  await rollback.apply({ caseId, checkpointId: restored.undoCheckpoint.id, expectedRevision: undo.expectedRevision, previewToken: undo.token, actor });
  const reopened = await child('reopen-after-undo', 'outputs.ts', ['show', ...commonArgs(), '--output', hearing.draft.outputId]);
  check('undo.review_output_reads_in_new_process', reopened.exitCode === 0 && reopened.stdout.includes(hearing.draft.outputId));

  if (values['natural-language-smoke']) {
    const result = await child('natural-language-smoke', 'agent.ts', [...commonArgs(), '--plugin', plugin,
      '--once', '请通过案件材料目录列出本案现有材料的名称，先不要整理材料或作专业判断。']);
    check('natural_language.material_lookup', result.exitCode === 0 && result.stdout.includes(fixture.intake[0].label));
  }
  report.status = report.assertions.every((item) => item.ok) ? 'passed' : 'checks_failed';
} catch (error) {
  report.status = 'failed';
  report.error = scrub(error instanceof Error ? error.message : String(error));
} finally {
  report.finishedAt = new Date().toISOString();
  await saveReport();
  console.log(JSON.stringify({ status: report.status, report: reportPath,
    failedChecks: report.assertions.filter((item) => !item.ok).map((item) => item.name) }));
}
if (report.status !== 'passed') process.exitCode = 1;
