/**
 * 成果区块测试：只渲染有出处的判断，缺口不硬塞。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assessRun } from '../src/kernel/assess.ts';
import { renderSections } from '../src/kernel/sections.ts';
import { buildLaborKnowledge } from '../src/labor/issues.ts';
import { TERMINATION_RUN, WAGE_GAP_RUN } from './fixtures/runs.ts';

const knowledge = buildLaborKnowledge();

test('区块顺序稳定，且每个区块都有内容', () => {
  const assessment = assessRun(knowledge, WAGE_GAP_RUN);
  const sections = renderSections(knowledge, assessment, WAGE_GAP_RUN);
  assert.deepEqual(sections.map((section) => section.id), [
    'domain.issue-overview', 'domain.element-matrix', 'domain.ledger', 'domain.gaps',
  ]);
  for (const section of sections) {
    assert.ok(section.paragraphs.length + section.tables.length > 0, `空区块不应输出：${section.id}`);
    assert.equal(section.provider.id, 'labor.cn');
    assert.equal(section.provider.version, knowledge.version);
  }
});

test('争点总览只列有出处的争点', () => {
  const assessment = assessRun(knowledge, WAGE_GAP_RUN);
  const overview = renderSections(knowledge, assessment, WAGE_GAP_RUN).find((section) => section.id === 'domain.issue-overview');
  assert.ok(overview);
  // 劳动关系、工资支付有直接记载；二倍工资因与工资标准共用一条需求也会出现。
  // 解除与兜底争点没有任何记载，不应出现在总览里。
  assert.equal(overview.paragraphs.length, 3);
  const text = overview.paragraphs.map((paragraph) => paragraph.text).join('\n');
  assert.match(text, /劳动关系确认/u);
  assert.match(text, /工资支付/u);
  assert.doesNotMatch(text, /解除与终止/u);
  for (const paragraph of overview.paragraphs) assert.ok(paragraph.findingIds.length > 0);
});

test('工资台账按期间归集，缺失月份在缺口区块里被点名', () => {
  const assessment = assessRun(knowledge, WAGE_GAP_RUN);
  const sections = renderSections(knowledge, assessment, WAGE_GAP_RUN);

  const ledger = sections.find((section) => section.id === 'domain.ledger');
  assert.ok(ledger?.tables[0]);
  assert.deepEqual(ledger.tables[0].columns, ['期间/日期', '事项', '金额', '记载条数']);
  const periods = ledger.tables[0].rows.map((row) => row.cells[0]);
  assert.ok(periods.includes('2024-06'), '欠付月份也应出现在台账里');

  const gaps = sections.find((section) => section.id === 'domain.gaps');
  assert.ok(gaps);
  const text = gaps.paragraphs.map((paragraph) => paragraph.text).join('\n');
  assert.match(text, /2024-06/u, '缺口区块应点名缺失月份');
  assert.match(text, /缺记录/u);
});

test('完全没有材料的缺口不进区块，改为提示去看缺口清单', () => {
  const assessment = assessRun(knowledge, WAGE_GAP_RUN);
  const gaps = renderSections(knowledge, assessment, WAGE_GAP_RUN).find((section) => section.id === 'domain.gaps');
  assert.ok(gaps);
  const hidden = gaps.paragraphs.at(-1);
  assert.match(hidden?.text ?? '', /完全没有对应材料/u);
  assert.match(hidden?.text ?? '', /缺口清单/u);
  // 兜底段落也必须带出处，否则整段无法通过底座校验
  assert.ok((hidden?.findingIds.length ?? 0) > 0);
});

test('解除场景：路径对比区块只列有出处的那条，并明说不推荐', () => {
  const assessment = assessRun(knowledge, TERMINATION_RUN);
  const paths = renderSections(knowledge, assessment, TERMINATION_RUN).find((section) => section.id === 'domain.paths');
  assert.ok(paths, '解除争点应有路径对比区块');

  const table = paths.tables[0];
  assert.ok(table);
  assert.deepEqual(table.columns, ['路径', '状态', '法律结果', '所属争点', '缺口']);
  assert.equal(table.rows.length, 1, '只有"单位作出解除"这条有出处');
  assert.match(table.rows[0]?.cells[0] ?? '', /单位单方解除/u);
  for (const row of table.rows) assert.ok(row.findingIds.length > 0);

  const text = paths.paragraphs.map((paragraph) => paragraph.text).join('\n');
  assert.match(text, /另有 2 条路径/u, '没有出处的路径只提示条数');
  assert.match(text, /不作推荐/u, '必须明示不推荐');
  for (const paragraph of paths.paragraphs) assert.ok(paragraph.findingIds.length > 0);
});

test('没有任何 finding 的运行不产出区块', () => {
  const empty = {
    ...WAGE_GAP_RUN, findings: [],
    information: {
      version: 1 as const, entities: [], relations: [], conflicts: [],
      needs: (WAGE_GAP_RUN.information?.needs ?? []).map((item) => ({
        ...item, findingIds: [], coverage: 'not_found_in_examined' as const,
        support: 'none' as const, satisfaction: 'needs_information' as const,
      })),
    },
  };
  const assessment = assessRun(knowledge, empty);
  assert.deepEqual(renderSections(knowledge, assessment, empty), []);
});

test('用通用 profile 跑出的运行不会被劳动法插件"收编"', () => {
  const foreign = {
    ...WAGE_GAP_RUN,
    findings: WAGE_GAP_RUN.findings.map((finding) => ({ ...finding, needId: 'common.events' })),
    information: {
      version: 1 as const, entities: [], relations: [], conflicts: [],
      needs: [{ ...(WAGE_GAP_RUN.information!.needs[0]!), needId: 'common.events' }],
    },
  };
  const assessment = assessRun(knowledge, foreign);
  assert.deepEqual(renderSections(knowledge, assessment, foreign), [], '与本法域无关的记载不应进入专业区块');
});

test('解除场景：区块只呈现有出处的部分，且引用都可回溯', () => {
  const assessment = assessRun(knowledge, TERMINATION_RUN);
  const sections = renderSections(knowledge, assessment, TERMINATION_RUN);
  const ids = new Set(TERMINATION_RUN.findings.map((finding) => finding.id));
  assert.ok(sections.length > 0);
  for (const section of sections) {
    for (const paragraph of section.paragraphs) {
      for (const id of paragraph.findingIds) assert.ok(ids.has(id));
    }
    for (const table of section.tables) {
      for (const row of table.rows) {
        for (const id of row.findingIds) assert.ok(ids.has(id));
        assert.equal(row.cells.length, table.columns.length);
      }
    }
  }
});
