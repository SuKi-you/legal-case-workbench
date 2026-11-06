/**
 * 劳动法知识包测试：结构自洽、要件与需求的对应、两个真实场景的判定结果。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assessRun, buildProofTasks } from '../src/kernel/assess.ts';
import { validateKnowledge } from '../src/kernel/schema.ts';
import type { RunView } from '../src/kernel/contracts.ts';
import { LABOR_ELEMENTS, LABOR_NEEDS, needUsage } from '../src/labor/elements.ts';
import { buildLaborKnowledge } from '../src/labor/issues.ts';
import { LABOR_SOURCES } from '../src/labor/sources.ts';
import { TERMINATION_RUN, WAGE_GAP_RUN } from './fixtures/runs.ts';

const knowledge = buildLaborKnowledge();

test('知识包结构与引用完整性全部通过', () => {
  assert.deepEqual(validateKnowledge(knowledge), []);
});

test('每个要件都有需求，每个需求都被用上', () => {
  const usage = needUsage();
  for (const need of LABOR_NEEDS) {
    assert.ok((usage.get(need.id)?.length ?? 0) > 0, `需求没有被任何要件使用：${need.id}`);
  }
  for (const element of LABOR_ELEMENTS) {
    assert.ok(element.needs.length > 0, `要件没有需求：${element.id}`);
    for (const needId of element.needs) {
      assert.ok(LABOR_NEEDS.some((need) => need.id === needId), `要件引用了不存在的需求：${element.id} → ${needId}`);
    }
  }
});

test('要件引用的法源都已在法源表登记', () => {
  for (const element of LABOR_ELEMENTS) {
    for (const sourceId of element.statute ?? []) {
      const source = LABOR_SOURCES[sourceId];
      assert.ok(source, `未登记的法源：${element.id} → ${sourceId}`);
      assert.equal(source.id, sourceId);
      assert.notEqual(source.validity, 'repealed', `已废止法源不得作为依据：${sourceId}`);
    }
  }
});

test('id 全局唯一；关键设计标记存在', () => {
  assert.equal(new Set(LABOR_ELEMENTS.map((item) => item.id)).size, LABOR_ELEMENTS.length);
  assert.equal(new Set(LABOR_NEEDS.map((item) => item.id)).size, LABOR_NEEDS.length);
  assert.equal(new Set(knowledge.issues.map((item) => item.id)).size, knowledge.issues.length);

  // 工资支付记录必须逐月核对，否则"缺某个月"根本发现不了
  assert.equal(LABOR_ELEMENTS.find((item) => item.id === 'labor.wage.payment')?.periodic, true);
  // 未订立书面合同是消极事实，举证责任在对方
  assert.equal(LABOR_ELEMENTS.find((item) => item.id === 'labor.double.signed')?.negative, true);
  // 评价性要件不得成为核心要件，否则争点永远无法判定
  for (const element of LABOR_ELEMENTS) {
    if (element.kind === 'evaluative') assert.equal(element.critical, false, `评价性要件不应为核心要件：${element.id}`);
  }
});

test('场景 A：工资支付——缺 6 月被发现，争点可判断', () => {
  const assessment = assessRun(knowledge, WAGE_GAP_RUN);

  const state = (id: string) => assessment.elements.find((item) => item.elementId === id)?.state;
  assert.equal(state('labor.wage.standard'), 'satisfied', '工资标准有书证');
  assert.equal(state('labor.wage.payment'), 'satisfied', '逐月记录已找到');
  assert.equal(state('labor.wage.unpaid'), 'statement_only', '欠付主张只有陈述');

  const wageIssue = assessment.issues.find((item) => item.issueId === 'labor.wage');
  assert.equal(wageIssue?.state, 'judgeable');

  const missing = assessment.gaps.find((gap) => gap.kind === 'missing_period');
  assert.ok(missing, '应报出缺失月份');
  assert.match(missing.detail ?? '', /2024-06/u);
  assert.match(missing.consequence, /缺记录/u, '必须区分"缺记录"与"未支付"');
  assert.ok(missing.findingIds.length > 0, '缺失月份也要能指回已有出处');

  assert.equal(assessment.route[0]?.issueId, 'labor.wage');
  assert.ok(assessment.warnings.some((warning) => warning.includes('待验证')), '未核验法源必须给出警告');
});

test('场景 A：劳动关系争点因缺报酬支付要件判为材料不足', () => {
  const assessment = assessRun(knowledge, WAGE_GAP_RUN);
  const relationship = assessment.issues.find((item) => item.issueId === 'labor.relationship');
  assert.equal(relationship?.state, 'insufficient');
  const pay = assessment.gaps.find((gap) => gap.elementId === 'labor.relationship.pay');
  assert.ok(pay, '缺报酬支付外观应形成缺口');
  assert.equal(pay.kind, 'absent');
  assert.doesNotMatch(pay.consequence, /不存在/u, '不得把"没有记载"写成"不存在"');
});

test('场景 B：口头解除——起点事实只有陈述，仍可判断，但缺口指向对方举证', () => {
  const assessment = assessRun(knowledge, TERMINATION_RUN);

  const trigger = assessment.elements.find((item) => item.elementId === 'labor.termination.by-employer');
  assert.equal(trigger?.state, 'statement_only');
  assert.equal(trigger?.burden, 'respondent');

  const termination = assessment.issues.find((item) => item.issueId === 'labor.termination');
  assert.equal(termination?.state, 'judgeable');

  const reason = assessment.gaps.find((gap) => gap.elementId === 'labor.termination.reason');
  assert.ok(reason, '解除理由缺记载应形成缺口');
  assert.match(reason.consequence, /对方/u, '单位掌握解除决定，举证责任在对方');

  assert.equal(assessment.route[0]?.issueId, 'labor.termination');
});

// ── 路径：同一句"你别来了"，三条路并列 ───────────────────────────
test('解除路径：三条并列，只有"单位作出"这一条要件齐备', () => {
  const assessment = assessRun(knowledge, TERMINATION_RUN);
  assert.equal(assessment.paths.length, 3);

  const byId = (id: string) => assessment.paths.find((path) => path.pathId === id);
  assert.equal(byId('labor.path.unilateral')?.state, 'available');
  assert.equal(byId('labor.path.forced')?.state, 'insufficient');
  assert.equal(byId('labor.path.consensus')?.state, 'insufficient');

  // 每条路径都给出法律结果与测算入口，但不自动算钱
  assert.match(byId('labor.path.unilateral')?.outcome ?? '', /2N|二倍/u);
  assert.equal(byId('labor.path.unilateral')?.calcPath, 'illegal-termination');
  assert.equal(byId('labor.path.forced')?.calcPath, 'severance');
  // 路径不改变争点状态
  assert.equal(assessment.issues.find((issue) => issue.issueId === 'labor.termination')?.state, 'judgeable');
});

test('解除路径：起点事实缺失时三条全为缺要件，不得默认按单位提出', () => {
  const assessment = assessRun(knowledge, WAGE_GAP_RUN);
  const terminationPaths = assessment.paths.filter((path) => path.issueId === 'labor.termination');
  assert.equal(terminationPaths.length, 3);
  assert.ok(terminationPaths.every((path) => path.state === 'insufficient'), '三条路径都缺起点事实');
  assert.ok(terminationPaths.every((path) => path.state !== 'available'), '不得默认存在单位解除');
  assert.ok(assessment.warnings.some((warning) => warning.includes('多条路径均缺要件')));
});

// ── 抗辩：只提示可能性，不作结论 ─────────────────────────────────
test('抗辩：未有管理记载时提示劳务关系抗辩，时效抗辩随时待查', () => {
  const assessment = assessRun(knowledge, TERMINATION_RUN);
  const byId = (id: string) => assessment.defenses.find((defense) => defense.defenseId === id);

  assert.equal(byId('labor.defense.service')?.state, 'unlikely', '仅缺从属性记载不能推定存在劳务协议');
  assert.ok((byId('labor.defense.service')?.response.length ?? 0) > 0, '必须给出我方需补材料');

  // 解除时间已有记载 → 时效抗辩具备提出条件
  assert.equal(byId('labor.defense.limitation')?.state, 'unlikely', '单有日期不表示已过时效');
  // 抗辩不改变争点状态
  assert.equal(assessment.issues.find((issue) => issue.issueId === 'labor.termination')?.state, 'judgeable');
  assert.equal(assessment.defenses.some((defense) => defense.state === 'grounded'), false);
});

test('任务目标中的抗辩关键词不作为案件线索', () => {
  const withSignal = assessRun(knowledge, {
    ...TERMINATION_RUN,
    goal: '单位以严重违纪为由解除，员工手册有签收',
  });
  const misconduct = withSignal.defenses.find((defense) => defense.defenseId === 'labor.defense.misconduct');
  assert.equal(misconduct?.state, 'unlikely', '任务目标中的关键词不是案件支持材料');
  assert.equal(misconduct?.signals.length, 0);
});

test('仅任务目标提到考勤时，不改变加班事实举证方向', () => {
  const without = assessRun(knowledge, WAGE_GAP_RUN);
  const withSignal = assessRun(knowledge, { ...WAGE_GAP_RUN, goal: '整理工资与考勤记录，核对加班情况' });

  const overtimeOf = (assessment: typeof without) => assessment.elements.find((item) => item.elementId === 'labor.wage.overtime');
  assert.equal(overtimeOf(without)?.burden, 'claimant', '基准：加班事实由劳动者举证');
  assert.equal(overtimeOf(withSignal)?.burden, 'claimant', '仅在任务中提到考勤不能证明单位控制加班证据');
  assert.equal(overtimeOf(withSignal)?.burdenShiftReason, undefined);
  // 转移不改变要件状态
  assert.equal(overtimeOf(withSignal)?.state, 'absent');
});

test('二倍工资：拒签标签不能直接排除，仍需核实具体例外', () => {
  const run: RunView = {
    id: 'r-exclusion', goal: '未签书面合同能否主张二倍工资', status: 'completed',
    sources: [{ materialId: 'm1', versionId: 'v1' }],
    findings: [{
      id: 'f1', needId: 'labor.need.double-exclusion', statement: '入职时劳动者拒绝签订书面合同',
      citations: [{ materialId: 'm1', versionId: 'v1', start: 0, end: 4, quote: '拒绝签订' }],
    }],
    information: {
      needs: [{
        needId: 'labor.need.double-exclusion', coverage: 'found', support: 'document_supported',
        satisfaction: 'satisfied', consistency: 'consistent',
      }],
    },
  };
  const assessment = assessRun(knowledge, run);
  assert.equal(assessment.issues.find((issue) => issue.issueId === 'labor.double-wage')?.state, 'insufficient');
  assert.notEqual(assessment.issues.find((issue) => issue.issueId === 'labor.double-wage')?.state, 'not_applicable');
});

test('事实因子：从属性材料完整度按权重聚合，只给档位', () => {
  const weak = assessRun(knowledge, WAGE_GAP_RUN).factors.find((item) => item.factorId === 'labor.factor.subordination');
  assert.ok(weak);
  // 从属性 statement_only(0.5×3) + 实际用工 statement_only(0.5×2) = 2.5 / 9
  assert.equal(weak.score, 0.28);
  assert.equal(weak.band, '较弱');
  assert.equal(weak.contributions.length, 5);
  assert.match(weak.note, /不构成劳动关系认定/u);

  const strong = assessRun(knowledge, {
    ...WAGE_GAP_RUN,
    information: {
      needs: ['labor.need.subordination', 'labor.need.work', 'labor.need.business', 'labor.need.pay', 'labor.need.relation.form']
        .map((needId) => ({ needId, coverage: 'found', support: 'document_supported', satisfaction: 'satisfied', consistency: 'consistent' })),
    },
  }).factors.find((item) => item.factorId === 'labor.factor.subordination');
  assert.equal(strong?.score, 1);
  assert.equal(strong?.band, '较强');
});

test('专业校验：口头解除与工资空月分别都能命中', () => {
  const explicitOral = structuredClone(TERMINATION_RUN);
  const form = explicitOral.findings.find((finding) => finding.needId === 'labor.need.term-form')!;
  form.statement = '公司以口头通知方式告知不用到岗。';
  form.record!.value = { kind: 'text', raw: '口头通知', normalized: '口头通知', unit: null };
  form.record!.polarity = 'affirmed';
  form.citations = form.citations.map((citation) => ({ ...citation, start: 0, end: form.statement.length, quote: form.statement }));
  const termination = assessRun(knowledge, explicitOral);
  const oral = termination.checks.find((check) => check.checkId === 'labor.check.oral-unilateral');
  assert.ok(oral, '单位口头解除应命中校验');
  assert.equal(oral.severity, 'warn');
  assert.ok(oral.statute.length > 0, '校验必须带法源');

  const wage = assessRun(knowledge, WAGE_GAP_RUN);
  assert.ok(wage.checks.some((check) => check.checkId === 'labor.check.wage-gap-month'));
  // 校验不改变争点状态
  assert.equal(wage.issues.find((issue) => issue.issueId === 'labor.wage')?.state, 'judgeable');
});

test('证明任务：由缺口派生"补什么、补到什么程度"', () => {
  const assessment = assessRun(knowledge, WAGE_GAP_RUN);
  const tasks = buildProofTasks(knowledge, assessment);
  assert.ok(tasks.length > 0);
  assert.equal(tasks.length, assessment.gaps.length, '每条缺口对应一个证明任务');

  const missingMonth = tasks.find((task) => task.gapKind === 'missing_period');
  assert.ok(missingMonth, '应产出缺失月份的证明任务');
  assert.match(missingMonth.goal, /2024-06/u);
  assert.equal(missingMonth.standard, 'document', '工资支付要求书证');
  assert.equal(missingMonth.burden, 'respondent', '凭证由单位掌握');

  for (const task of tasks) {
    assert.ok(task.goal.length > 0 && task.basis.length > 0);
    assert.ok(task.materials.length > 0);
  }
});

test('立场切换只改变后果措辞，不改变判定', () => {  const claimant = assessRun(buildLaborKnowledge({ stance: 'claimant' }), TERMINATION_RUN);
  const respondent = assessRun(buildLaborKnowledge({ stance: 'respondent' }), TERMINATION_RUN);

  const pick = (assessment: typeof claimant): string =>
    assessment.gaps.find((gap) => gap.elementId === 'labor.termination.reason')?.consequence ?? '';
  assert.match(pick(claimant), /对方/u);
  assert.match(pick(respondent), /本方/u);

  const stateOf = (assessment: typeof claimant): string | undefined =>
    assessment.issues.find((item) => item.issueId === 'labor.termination')?.state;
  assert.equal(stateOf(claimant), stateOf(respondent), '立场不应改变争点状态');
});

test('空运行：区分已核对未见与未读取，路由只作关键词建议', () => {
  const empty = {
    ...WAGE_GAP_RUN,
    findings: [],
    information: {
      version: 1 as const, entities: [], relations: [], conflicts: [],
      needs: (WAGE_GAP_RUN.information?.needs ?? []).map((item) => ({
        ...item, findingIds: [], coverage: 'not_found_in_examined' as const,
        support: 'none' as const, satisfaction: 'needs_information' as const,
      })),
    },
  };
  const assessment = assessRun(knowledge, empty);
  // 没有证据时不允许凭"说法"排序：命中理由里不应出现"已提取到记载"
  for (const hit of assessment.route) {
    assert.ok(hit.reasons.every((reason) => reason.includes('关键词')), `无证据时不应凭记载打分：${hit.reasons.join('；')}`);
  }
  assert.equal(assessment.fallbackIssueId, 'labor.general');
  assert.ok(assessment.elements.every((element) => element.state === 'absent' || element.state === 'unread'));
  assert.ok(assessment.gaps.length > 0);
});
