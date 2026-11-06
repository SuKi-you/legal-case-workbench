import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { compareInformation } from '../../底座/src/information/compare.ts';
import { evaluateInformationNeeds } from '../../底座/src/information/coverage.ts';
import type { InformationFinding, InformationRecord } from '../../底座/src/information/contracts.ts';
import { assessRun, buildProofTasks, missingPeriods } from '../src/kernel/assess.ts';
import { validateKnowledge } from '../src/kernel/schema.ts';
import { LABOR_NEEDS } from '../src/labor/elements.ts';
import { buildLaborKnowledge } from '../src/labor/issues.ts';
import { TERMINATION_RUN, WAGE_GAP_RUN } from './fixtures/runs.ts';

const knowledge = buildLaborKnowledge();
const noticeNeed = LABOR_NEEDS.find(item => item.id === 'labor.need.term.by-employer')!;
function notice(input: { period: string; date: string; key: string; polarity: 'affirmed' | 'denied'; employee?: string }): InformationFinding {
  const employee = input.employee ?? 'E1';
  const quote = `星桥公司${input.date}${input.polarity === 'affirmed' ? '通知' : '未通知'}陈某${employee}解除，编号${input.key}。`;
  const record: InformationRecord = {
    topic: noticeNeed.spec!.topic,
    subject: { name: '星桥公司', kind: 'organization', identity: { scheme: 'organization_id', value: 'C1' } },
    object: { name: `陈某${employee}`, kind: 'person', identity: { scheme: 'employee_id', value: employee } },
    attributedTo: null, event: { type: noticeNeed.spec!.topic, key: input.key, description: quote },
    time: { raw: input.date, start: input.date, end: input.date, precision: 'date' },
    value: { kind: 'boolean', raw: input.polarity === 'affirmed' ? '通知' : '未通知', normalized: input.polarity === 'affirmed' ? 'true' : 'false', unit: null },
    polarity: input.polarity, period: input.period, basis: null, origin: 'document_record', qualifiers: {}, uncertainty: [],
  };
  return { id: randomUUID(), needId: noticeNeed.id, statement: quote, record,
    citations: [{ materialId: randomUUID(), versionId: randomUUID(), textSha256: 'a'.repeat(64), start: 0, end: quote.length, quote }] };
}
function assessedNotices(findings: InformationFinding[]) {
  const sources = findings.map(finding => {
    const { materialId, versionId, textSha256 } = finding.citations[0]!;
    return { materialId, versionId, textSha256 };
  });
  const attempts = findings.map((finding, index) => ({ request: { needId: noticeNeed.id, instruction: '核对通知记录', reason: '独立复审', sources: [sources[index]!] },
    examined: [sources[index]!], findingIds: [finding.id], note: '离线机制验证' }));
  const comparison = compareInformation(findings);
  const needs = evaluateInformationNeeds({ needs: [noticeNeed], findings, sources, attempts, conflicts: comparison.conflicts });
  const run = { id: randomUUID(), goal: '核对材料记录，不预先合并不同事件', status: 'completed', sources, findings,
    information: { version: 1 as const, ...comparison, needs } };
  return { run, assessment: assessRun(knowledge, run), coverage: needs[0]!, comparison };
}

test('different years and distinct notice IDs are not collapsed into a contradictory positive proposition', () => {
  const result = assessedNotices([
    notice({ period: '2024-01', date: '2024-01-01', key: 'N2024', polarity: 'affirmed' }),
    notice({ period: '2026-01', date: '2026-01-01', key: 'N2026', polarity: 'denied' }),
  ]);
  assert.equal(result.coverage.consistency, 'consistent');
  assert.ok(result.comparison.conflicts.some(item => item.classification === 'different_scope'));
  const element = result.assessment.elements.find(item => item.elementId === 'labor.termination.by-employer')!;
  assert.equal(element.state, 'needs_review'); assert.match(element.scopeNote!, /范围|期间|事件/u);
  assert.equal(result.assessment.gaps.some(item => item.elementId === element.elementId && item.kind === 'conflicting'), false);
  assert.equal(element.findingIds.length, 2);
});

test('opposing answers about the same identified event and participants still create a real conflict', () => {
  const result = assessedNotices([
    notice({ period: '2026-01', date: '2026-01-01', key: 'N1', polarity: 'affirmed' }),
    notice({ period: '2026-01', date: '2026-01-01', key: 'N1', polarity: 'denied' }),
  ]);
  assert.equal(result.assessment.elements.find(item => item.elementId === 'labor.termination.by-employer')?.state, 'conflicting');
});

test('records about two explicitly different employees do not become one employee contradiction', () => {
  const result = assessedNotices([
    notice({ period: '2026-01', date: '2026-01-01', key: 'N1', polarity: 'affirmed', employee: 'E1' }),
    notice({ period: '2026-01', date: '2026-01-01', key: 'N1', polarity: 'denied', employee: 'E2' }),
  ]);
  assert.equal(result.assessment.elements.find(item => item.elementId === 'labor.termination.by-employer')?.state, 'needs_review');
});

test('without base comparison, a month alone cannot establish that two opposite records describe the same event', () => {
  const findings = [
    notice({ period: '2026-01', date: '2026-01-01', key: 'N1', polarity: 'affirmed' }),
    notice({ period: '2026-01', date: '2026-01-01', key: 'N1', polarity: 'denied' }),
  ];
  for (const finding of findings) {
    finding.record!.event.key = null;
    finding.record!.time = { raw: '一月', start: null, end: null, precision: 'month' };
  }
  const result = assessRun(knowledge, { id: randomUUID(), status: 'completed', goal: '核对通知', sources: [], findings });
  assert.equal(result.elements.find(item => item.elementId === 'labor.termination.by-employer')?.state, 'needs_review');
});

function notificationForm(value: string) {
  const run = structuredClone(TERMINATION_RUN);
  const form = run.findings.find(item => item.needId === 'labor.need.term-form')!;
  form.statement = `公司给我${value}。`;
  form.record!.value = { kind: 'text', raw: value, normalized: value, unit: null };
  form.record!.event.description = form.statement; form.record!.polarity = 'affirmed';
  form.citations = form.citations.map(citation => ({ ...citation, start: 0, end: form.statement.length, quote: form.statement }));
  return run;
}

test('a statement of written notice is not mislabeled oral merely because its source is a party statement', () => {
  const result = assessRun(knowledge, notificationForm('书面解除通知'));
  assert.equal(result.elements.find(item => item.elementId === 'labor.termination.form')?.state, 'statement_only');
  assert.equal(result.checks.some(item => item.checkId === 'labor.check.oral-unilateral'), false);
});

test('an explicit oral form keeps its positive reminder without inventing absence of written documents', () => {
  const result = assessRun(knowledge, notificationForm('口头通知'));
  const check = result.checks.find(item => item.checkId === 'labor.check.oral-unilateral');
  assert.ok(check); assert.match(check.message, /不等于已确认没有书面/u);
});

test('a document-supported oral notification keeps its reminder too: support category does not decide notification form', () => {
  const run = notificationForm('口头通知');
  run.findings.find(item => item.needId === 'labor.need.term-form')!.record!.origin = 'document_record';
  run.information!.needs.find(item => item.needId === 'labor.need.term-form')!.support = 'document_supported';
  assert.ok(assessRun(knowledge, run).checks.some(item => item.checkId === 'labor.check.oral-unilateral'));
});

test('not having a written document does not by itself establish oral notification', () => {
  assert.equal(assessRun(knowledge, TERMINATION_RUN).checks.some(item => item.checkId === 'labor.check.oral-unilateral'), false);
});

function wageSeries() {
  const run = structuredClone(WAGE_GAP_RUN);
  run.findings = run.findings.filter(item => item.needId !== 'labor.need.wage-unpaid'
    && (item.needId !== 'labor.need.wage-payment' || ['2024-04', '2024-05'].includes(item.record!.period!)));
  return run;
}

test('two contiguous payroll months do not trigger a fabricated missing-month check', () => {
  const result = assessRun(knowledge, wageSeries());
  assert.equal(result.gaps.some(item => item.kind === 'missing_period'), false);
  assert.equal(result.checks.some(item => item.checkId === 'labor.check.wage-gap-month'), false);
});

test('a real hole in one employee payroll series still triggers the specific reminder', () => {
  const result = assessRun(knowledge, WAGE_GAP_RUN);
  assert.ok(result.gaps.some(item => item.kind === 'missing_period' && item.detail?.includes('2024-06')));
  assert.ok(result.checks.some(item => item.checkId === 'labor.check.wage-gap-month'));
});

test('payroll from different employees or different calculation bases cannot create a shared missing month', () => {
  for (const dimension of ['employee', 'basis', 'unit', 'qualifiers'] as const) {
    const run = wageSeries();
    const payments = run.findings.filter(item => item.needId === 'labor.need.wage-payment');
    payments[1]!.record!.period = '2024-06';
    if (dimension === 'employee') {
      payments[0]!.record!.subject = { name: '陈某', kind: 'person', identity: { scheme: 'employee_id', value: 'E1' } };
      payments[1]!.record!.subject = { name: '李某', kind: 'person', identity: { scheme: 'employee_id', value: 'E2' } };
    } else if (dimension === 'basis') {
      payments[0]!.record!.basis = '税前'; payments[1]!.record!.basis = '实发';
    } else if (dimension === 'unit') {
      payments[0]!.record!.value.unit = '人民币'; payments[1]!.record!.value.unit = '美元';
    } else {
      payments[0]!.record!.qualifiers = { 项目: '基本工资' };
      payments[1]!.record!.qualifiers = { 项目: '提成' };
    }
    const result = assessRun(knowledge, run);
    assert.equal(result.gaps.some(item => item.kind === 'missing_period'), false, dimension);
    assert.equal(result.checks.some(item => item.checkId === 'labor.check.wage-gap-month'), false, dimension);
  }
  assert.deepEqual(missingPeriods(['2024-11', '2024-13']), []);
});

test('two employees with genuine payroll holes retain separate gaps and unique proof-task identifiers', () => {
  const run = wageSeries();
  const payments = run.findings.filter(item => item.needId === 'labor.need.wage-payment');
  payments[1]!.record!.period = '2024-06';
  const secondEmployee = structuredClone(payments).map(finding => {
    finding.id = randomUUID();
    finding.record!.subject = { name: '李某', kind: 'person', identity: { scheme: 'employee_id', value: 'E2' } };
    return finding;
  });
  run.findings.push(...secondEmployee);
  const assessment = assessRun(knowledge, run);
  const gaps = assessment.gaps.filter(item => item.kind === 'missing_period');
  assert.equal(gaps.length, 2);
  assert.equal(gaps.every(gap => gap.findingIds.length === 2), true);
  assert.equal(gaps.every(gap => gap.detail?.includes('2024-05')), true);
  const tasks = buildProofTasks(knowledge, assessment);
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length);
});

test('new check predicates are validated instead of silently accepting unknown needs or elements', () => {
  const base = knowledge.checks![0]!;
  const invalid = { ...knowledge, checks: [{ ...base, claim: { needId: 'absent.need', values: ['oral'] } },
    { ...base, id: 'invalid.gap', gap: { elementId: 'absent.element', kind: 'missing_period' as const } }] };
  const problems = validateKnowledge(invalid);
  assert.ok(problems.some(message => message.includes('结构化主张条件无效')));
  assert.ok(problems.some(message => message.includes('缺口条件无效')));
});
