/**
 * 通用性测试：把 kernel 交给一个**完全不属于劳动法**的迷你知识包。
 *
 * 这里刻意不 import 劳动法知识包、不 import 底座：
 * 如果 kernel 真的通用，换法域应当只是换数据。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  gapKindOf, missingPeriods, stateFromCoverage, assessRun, routeIssues,
} from '../src/kernel/assess.ts';
import { worstState } from '../src/kernel/contracts.ts';
import { assertKnowledge, validateKnowledge } from '../src/kernel/schema.ts';
import { restrictKnowledge } from '../src/kernel/restrict.ts';
import type { DomainKnowledge, RunView } from '../src/kernel/contracts.ts';

/** 一个与劳动法无关的迷你法域：借用合同。 */
const LOAN: DomainKnowledge = {
  id: 'loan.demo', version: '0.0.1', domain: '借用合同（通用性验证）', stance: 'claimant',
  issues: [
    {
      id: 'loan.delivery', title: '借用物是否交付', caseTypes: ['借用合同'],
      elements: ['loan.delivery.fact'],
      rules: [
        { all: [{ elementId: 'loan.delivery.fact', in: ['satisfied', 'statement_only'] }], then: 'judgeable', reason: '已有交付事实' },
        { all: [], then: 'insufficient', reason: '缺交付事实' },
      ],
    },
    {
      id: 'loan.general', title: '兜底整理', caseTypes: ['其他'],
      elements: ['loan.general.event'],
      rules: [
        { all: [{ elementId: 'loan.general.event', in: ['satisfied', 'statement_only'] }], then: 'judgeable', reason: '已形成事件索引' },
        { all: [], then: 'insufficient', reason: '未提取到事实' },
      ],
    },
  ],
  elements: [
    {
      id: 'loan.delivery.fact', issueId: 'loan.delivery', title: '交付事实',
      needs: ['loan.need.delivery'], critical: true, kind: 'factual', burden: 'claimant',
      materials: ['financial', 'statement'], minimumSupport: 'document',
    },
    {
      id: 'loan.general.event', issueId: 'loan.general', title: '一般事件',
      needs: ['loan.need.event'], critical: false, kind: 'factual', burden: 'shared',
      materials: ['statement'],
    },
  ],
  sources: {}, fallbackIssueId: 'loan.general',
};

const run = (over: { findings?: RunView['findings']; information?: RunView['information'] } = {}): RunView => ({
  id: 'run-loan', goal: '借出相机一台，对方未归还', status: 'completed',
  sources: [{ materialId: 'm1', versionId: 'v1' }],
  findings: over.findings ?? [{
    id: 'f1', needId: 'loan.need.delivery', statement: '已把相机交给对方',
    citations: [{ materialId: 'm1', versionId: 'v1', start: 0, end: 4, quote: '已把相机' }],
  }],
  information: over.information ?? undefined,
});

test('同一套结构可以容纳另一个法域', () => {
  assert.doesNotThrow(() => assertKnowledge(LOAN));
});

test('有书证时事实要件可供判断，评价性要件仍等待人工', () => {
  const input = run({ information: { needs: [
    { needId: 'loan.need.delivery', coverage: 'found', support: 'document_supported' },
  ] } });
  const factual = assessRun(LOAN, input);
  assert.equal(factual.elements.find(item => item.elementId === 'loan.delivery.fact')?.state, 'satisfied');
  const knowledge: DomainKnowledge = {
    ...LOAN,
    elements: [{ ...LOAN.elements[0]!, kind: 'evaluative' }, ...LOAN.elements.slice(1)],
  };
  const assessed = assessRun(knowledge, input);
  const element = assessed.elements.find(item => item.elementId === 'loan.delivery.fact')!;
  assert.equal(element.informationState, 'satisfied');
  assert.equal(element.state, 'needs_review');
  assert.equal(element.evaluationPending, true);
  assert.deepEqual(element.missingMaterials, []);
  assert.equal(assessed.issues.find(item => item.issueId === 'loan.delivery')?.state, 'insufficient');
  const unread = assessRun(knowledge, run({ findings: [] }));
  assert.equal(unread.elements.find(item => item.elementId === element.elementId)?.state, 'unread');
});

test('知识包校验能指出具体问题，而不是笼统报错', () => {
  const broken = structuredClone(LOAN) as DomainKnowledge;
  (broken.elements[0] as unknown as { needs: string[] }).needs = [];
  // 最后一条不是兜底：一旦要件组合不在枚举内，就会无法归类
  (broken.issues[0] as unknown as { rules: unknown[] }).rules = [
    { all: [{ elementId: 'loan.delivery.fact', in: ['satisfied'] }], then: 'judgeable', reason: '缺兜底规则' },
  ];
  const problems = validateKnowledge(broken);
  assert.ok(problems.some((item) => item.includes('没有对应信息需求')), problems.join('\n'));
  assert.ok(problems.some((item) => item.includes('最后一条规则必须是兜底')), problems.join('\n'));
  assert.throws(() => assertKnowledge(broken), /知识包校验未通过/u);
});

test('coverage 到要件状态的映射是保守的', () => {
  assert.equal(stateFromCoverage({ needId: 'n', satisfaction: 'not_applicable' }), 'not_applicable');
  assert.equal(stateFromCoverage({ needId: 'n', consistency: 'conflicting', coverage: 'found' }), 'conflicting');
  assert.equal(stateFromCoverage({ needId: 'n', coverage: 'unread' }), 'unread');
  assert.equal(stateFromCoverage({ needId: 'n', coverage: 'not_found_in_examined' }), 'absent');
  assert.equal(stateFromCoverage({ needId: 'n', coverage: 'found', support: 'document_supported' }), 'satisfied');
  assert.equal(stateFromCoverage({ needId: 'n', coverage: 'found', support: 'statement_only' }), 'statement_only');
  assert.equal(stateFromCoverage({ needId: 'n', coverage: 'found', support: 'none' }), 'absent');
  // 字段没齐一律降级，不能算达标
  assert.equal(stateFromCoverage({ needId: 'n', coverage: 'partial', support: 'document_supported', missingFields: ['value'] }), 'needs_review');
});

test('多需求合并取最坏，但忽略"不适用"', () => {
  assert.equal(worstState(['satisfied', 'absent']), 'absent');
  assert.equal(worstState(['absent', 'conflicting']), 'conflicting');
  assert.equal(worstState(['not_applicable', 'satisfied']), 'satisfied');
  assert.equal(worstState(['not_applicable']), 'not_applicable');
  assert.equal(worstState([]), 'absent');
});

test('周期性缺口只在已出现范围内推断空月', () => {
  assert.deepEqual(missingPeriods(['2024-01', '2024-03']), ['2024-02']);
  assert.deepEqual(missingPeriods(['2024-03', '2024-01', '2024-04']), ['2024-02']);
  assert.deepEqual(missingPeriods(['2024-01']), []);
  assert.deepEqual(missingPeriods(['2024-01', '2024-02', '2024-03']), []);
  // 超过 36 个月不做推断，避免跨度太大造成误报
  assert.deepEqual(missingPeriods(['2019-01', '2024-01']), []);
});

test('缺口类型区分"没材料""要求书证但只有陈述""消极事实"', () => {
  const element = { ...LOAN.elements[0]! };
  assert.equal(gapKindOf(element, 'satisfied'), null);
  assert.equal(gapKindOf(element, 'statement_only'), 'missing_document');
  assert.equal(gapKindOf({ ...element, minimumSupport: 'statement' }, 'statement_only'), null);
  assert.equal(gapKindOf(element, 'absent'), 'absent');
  assert.equal(gapKindOf({ ...element, negative: true }, 'absent'), 'negative_fact');
  assert.equal(gapKindOf(element, 'unread'), 'unread');
  assert.equal(gapKindOf({ ...element, kind: 'evaluative' }, 'statement_only'), 'evaluative');
});

test('评估结果：状态、缺口、与"对谁不利"', () => {
  const assessment = assessRun(LOAN, run());
  const delivery = assessment.elements.find((element) => element.elementId === 'loan.delivery.fact');
  assert.equal(delivery?.state, 'statement_only');
  assert.equal(delivery?.basis, 'findings');

  const gap = assessment.gaps.find((item) => item.elementId === 'loan.delivery.fact');
  assert.equal(gap?.kind, 'missing_document');
  assert.match(gap?.consequence ?? '', /本方/u, '主张方承担举证责任时，缺口后果应指向本方');
  assert.ok(gap?.findingIds.includes('f1'), '缺口应保留已有出处，便于在区块中引用');

  const issue = assessment.issues.find((item) => item.issueId === 'loan.delivery');
  assert.equal(issue?.state, 'judgeable');
  assert.equal(assessment.route[0]?.issueId, 'loan.delivery');
});

test('立场相反时，同一缺口的后果措辞随之改变', () => {
  const claimant = assessRun({ ...LOAN, stance: 'claimant' }, run());
  const respondent = assessRun({ ...LOAN, stance: 'respondent' }, run());
  const text = (stance: 'claimant' | 'respondent'): string =>
    (stance === 'claimant' ? claimant : respondent).gaps.find((gap) => gap.elementId === 'loan.delivery.fact')?.consequence ?? '';
  assert.match(text('claimant'), /本方/u);
  assert.match(text('respondent'), /对方/u);
});

test('无覆盖率结果时给出警告，不把推断当结论', () => {
  const assessment = assessRun(LOAN, run());
  assert.ok(assessment.warnings.some((warning) => warning.includes('没有需求核对结果')));
});

// ── 裁剪：只装配部分争点 ───────────────────────────────────────────
test('裁剪知识包：争点、要件、抗辩条件、因子、路由同步收缩', () => {
  const full: DomainKnowledge = {
    ...LOAN_PATHS,
    routing: [{ issueId: 'loan.delivery', keywords: ['相机'] }],
    factors: [{
      id: 'loan.factor', title: '交付强度', issueId: 'loan.delivery',
      parts: [{ elementId: 'loan.delivery.fact', weight: 2 }],
      bands: [{ min: 0.5, label: '强', note: '' }], note: '提示',
    }],
    checks: [
      { id: 'loan.check.keep', title: '看交付', severity: 'info', when: [{ elementId: 'loan.delivery.fact', in: ['statement_only'] }], message: '仅有陈述', statute: [] },
      { id: 'loan.check.drop', title: '看一般事件', severity: 'info', when: [{ elementId: 'loan.general.event', in: ['satisfied'] }], message: 'x', statute: [] },
    ],
  };

  const trimmed = restrictKnowledge(full, ['loan.delivery']);
  assert.equal(trimmed.issues.length, 1);
  assert.equal(trimmed.elements.length, 2, '交付争点下有交付与损害两个要件');
  assert.equal(trimmed.fallbackIssueId, 'loan.delivery', '被裁掉的兜底争点由第一个保留争点顶替');
  assert.deepEqual(trimmed.routing?.map((rule) => rule.issueId), ['loan.delivery']);
  assert.equal(trimmed.factors?.length, 1);
  // 依赖被裁掉要件的校验整条丢弃
  assert.deepEqual(trimmed.checks?.map((check) => check.id), ['loan.check.keep']);
  // 抗辩保留，但成立条件裁到保留下来的要件
  const defense = trimmed.defenses?.find((item) => item.id === 'loan.defense.returned');
  assert.ok(defense);
  assert.deepEqual(defense.requires.map((item) => item.elementId), ['loan.delivery.fact']);
  assert.equal(validateKnowledge(trimmed).join(' | '), '');
});

test('裁剪后原本的路径仍可用，且 blockedBy 不会指向已裁掉的抗辩', () => {
  const trimmed = restrictKnowledge(LOAN_PATHS, ['loan.delivery']);
  const paths = trimmed.issues[0]?.paths ?? [];
  assert.equal(paths.length, 2);
  for (const path of paths) {
    for (const id of path.blockedBy ?? []) {
      assert.ok(trimmed.defenses?.some((defense) => defense.id === id), `blockedBy 指向了已裁掉的抗辩：${id}`);
    }
  }
});

test('裁剪：评价性要件的提问模板随要件一起裁掉', () => {
  const withOpinion: DomainKnowledge = {
    ...LOAN_PATHS,
    elements: [
      ...(LOAN_PATHS.elements ?? []),
      {
        id: 'loan.delivery.fairness', issueId: 'loan.delivery', title: '是否显失公平（评价性）',
        needs: ['loan.need.fairness'], critical: false, kind: 'evaluative', burden: 'claimant',
        materials: ['document'], minimumSupport: 'statement',
      },
    ],
    issues: [
      { ...LOAN_PATHS.issues[0]!, elements: [...(LOAN_PATHS.issues[0]?.elements ?? []), 'loan.delivery.fairness'] },
      LOAN_PATHS.issues[1]!,
    ],
    opinions: [{
      elementId: 'loan.delivery.fairness', question: '协议是否显失公平？',
      factors: ['金额差距', '谈判地位'],
    }],
  };

  const trimmed = restrictKnowledge(withOpinion, ['loan.delivery']);
  assert.equal(trimmed.opinions?.length, 1);
  assert.equal(validateKnowledge(trimmed).join(' | '), '');

  const without = restrictKnowledge(withOpinion, ['loan.general']);
  assert.deepEqual(without.opinions, [], '只有兜底争点时，评价性要件的模板应被裁掉');
  assert.equal(validateKnowledge(without).join(' | '), '');
});

test('案由路由按证据与关键词打分，可解释', () => {
  const hits = routeIssues(LOAN, run());
  assert.equal(hits[0]?.issueId, 'loan.delivery');
  assert.ok((hits[0]?.reasons.length ?? 0) > 0);
});

// ── 路径与抗辩的通用性（同一个 kernel，另一个法域） ────────────────
const LOAN_PATHS: DomainKnowledge = {
  ...LOAN,
  elements: [
    LOAN.elements[0]!,
    LOAN.elements[1]!,
    {
      id: 'loan.delivery.damage', issueId: 'loan.delivery', title: '损害事实',
      needs: ['loan.need.damage'], critical: false, kind: 'factual', burden: 'claimant',
      materials: ['document'], minimumSupport: 'statement',
    },
  ],
  issues: [
    {
      ...LOAN.issues[0]!,
      elements: ['loan.delivery.fact', 'loan.delivery.damage'],
      paths: [
        {
          id: 'loan.path.return', name: '要求返还原物',
          requires: [{ elementId: 'loan.delivery.fact', in: ['satisfied'] }],
          outcome: '返还原物', statute: [], reason: '交付是返还请求的前提。',
        },
        {
          id: 'loan.path.damages', name: '要求赔偿损失',
          requires: [
            { elementId: 'loan.delivery.fact', in: ['satisfied'] },
            { elementId: 'loan.delivery.damage', in: ['satisfied'] },
          ],
          blockedBy: ['loan.defense.returned'], outcome: '赔偿损失', statute: [], reason: '需同时具备交付与损害事实。',
        },
      ],
    },
    LOAN.issues[1]!,
  ],
  defenses: [
    {
      id: 'loan.defense.returned', name: '借用物已返还', against: ['loan.delivery'],
      requires: [{ elementId: 'loan.delivery.fact', in: ['statement_only'] }],
      signals: ['已还', '归还'], effect: 'block', response: ['返还凭证与交接记录'], statute: [],
      reason: '已返还则返还请求失去基础。',
    },
  ],
};

test('路径评估：并列输出，缺要件与"需核实"分开', () => {
  const assessment = assessRun(LOAN_PATHS, run());
  assert.equal(assessment.paths.length, 2);
  const byId = (id: string) => assessment.paths.find((path) => path.pathId === id);
  // 交付只有陈述：属于"需核实"，不是"没有材料"
  assert.equal(byId('loan.path.return')?.state, 'needs_check');
  // 赔偿路径挂了 blockedBy，而该抗辩所需事实已具备 → 阻断优先于缺口
  assert.equal(byId('loan.path.damages')?.state, 'blocked');
  assert.deepEqual(byId('loan.path.damages')?.blockedBy, ['loan.defense.returned']);
  assert.ok((byId('loan.path.damages')?.missing ?? []).includes('loan.delivery.damage'), '缺口仍要如实列出');

  // 缺的要件全部属于"没有记载"、且没有抗辩成立时，两条都判 insufficient
  const missing = assessRun(LOAN_PATHS, { ...run(), findings: [] });
  assert.ok(missing.paths.every((path) => path.state === 'insufficient'));
});

// ── 举证责任转移 ───────────────────────────────────────────────────
const LOAN_SHIFT: DomainKnowledge = {
  ...LOAN,
  elements: [
    {
      ...LOAN.elements[0]!,
      burdenShift: [{ when: [{ signal: '收据' }], then: 'respondent', reason: '收据由对方掌握，举证责任转移' }],
    },
    LOAN.elements[1]!,
  ],
};

// ── 事实因子 ───────────────────────────────────────────────────────
const LOAN_FACTOR: DomainKnowledge = {
  ...LOAN,
  factors: [{
    id: 'loan.factor.delivery', title: '交付证据强度', issueId: 'loan.delivery',
    parts: [{ elementId: 'loan.delivery.fact', weight: 3 }],
    bands: [
      { min: 0.8, label: '强', note: '有书证' },
      { min: 0.4, label: '中', note: '仅有陈述' },
      { min: 0, label: '弱', note: '无记载' },
    ],
    note: '提示性指标，不是法律认定',
  }],
};

test('事实因子：加权与分档是纯算术', () => {
  const assessment = assessRun(LOAN_FACTOR, run());
  const factor = assessment.factors[0];
  assert.ok(factor);
  // 仅有陈述 → 计一半权重
  assert.equal(factor.score, 0.5);
  assert.equal(factor.band, '中');
  assert.equal(factor.contributions.length, 1);
  assert.equal(factor.contributions[0]?.state, 'statement_only');
  assert.match(factor.note, /不是法律认定/u);
});

test('举证责任转移：命中线索词时改写"缺了对谁不利"', () => {
  const base = assessRun(LOAN, { ...run(), goal: '借出相机一台' });
  const shifted = assessRun(LOAN_SHIFT, { ...run(), findings: run().findings.map((finding) => ({ ...finding, statement: '已把相机交给对方，收据在对方手里' })) });

  const gapOf = (assessment: typeof base) => assessment.gaps.find((gap) => gap.elementId === 'loan.delivery.fact');
  assert.match(gapOf(base)?.consequence ?? '', /本方/u, '基准责任在本方');
  assert.match(gapOf(shifted)?.consequence ?? '', /对方/u, '转移后指向对方');

  const element = shifted.elements.find((item) => item.elementId === 'loan.delivery.fact');
  assert.equal(element?.burdenBase, 'claimant');
  assert.equal(element?.burden, 'respondent');
  assert.match(element?.burdenShiftReason ?? '', /收据/u);
  // 转移不改变要件状态
  assert.equal(element?.state, 'statement_only');
});

test('抗辩评估：事实齐备才阻断路径，线索词只提升可能性', () => {  // 用不含线索词的目标，避免"未归还"里命中"归还"
  const neutral = assessRun(LOAN_PATHS, { ...run(), goal: '借出相机一台' });
  const returned = neutral.defenses.find((defense) => defense.defenseId === 'loan.defense.returned');
  assert.equal(returned?.state, 'grounded', '所需事实（仅有陈述）已具备');
  assert.deepEqual(returned?.signals, []);
  // grounded 只表示具备提出条件，不改变争点状态
  assert.equal(neutral.issues.find((issue) => issue.issueId === 'loan.delivery')?.state, 'judgeable');
  // 只有 blockedBy 指向的抗辩 grounded 时，该路径才被阻断
  assert.equal(neutral.paths.find((path) => path.pathId === 'loan.path.damages')?.state, 'blocked');
  assert.equal(neutral.paths.find((path) => path.pathId === 'loan.path.return')?.state, 'needs_check');

  const withSignal = assessRun(LOAN_PATHS, { ...run(), findings: run().findings.map((finding) => ({ ...finding, statement: '相机已还，要求赔偿' })) });
  assert.deepEqual(withSignal.defenses.find((defense) => defense.defenseId === 'loan.defense.returned')?.signals, ['已还']);
});
