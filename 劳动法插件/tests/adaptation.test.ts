/**
 * 适配性测试：插件的产出必须能通过底座自己的 zod schema。
 *
 * 这不是"看起来像"，而是让底座的解析器来判定：
 * - profile 能通过 informationProfileSchema
 * - 工具能装进 AgentToolCatalog，输入校验走底座的 validate
 * - 成果区块能通过 outputSectionSchema，且只引用本运行内的 finding
 * - 底座的 LoopRun 在类型上可直接传给 kernel 的 RunView
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { informationProfileSchema } from '../../底座/src/agent/profiles.ts';
import { AgentToolCatalog } from '../../底座/src/agent-tools/catalog.ts';
import { loopRunSchema } from '../../底座/src/loops/contracts.ts';
import { outputSectionSchema } from '../../底座/src/outputs/contracts.ts';
import { validate } from '../../底座/src/validation.ts';

import laborPlugin, { createLaborPlugin } from '../src/index.ts';
import type { RunView } from '../src/kernel/contracts.ts';
import { TERMINATION_RUN, WAGE_GAP_RUN } from './fixtures/runs.ts';

test('夹具本身必须通过底座的 loopRunSchema', () => {
  for (const run of [WAGE_GAP_RUN, TERMINATION_RUN]) {
    const parsed = loopRunSchema.parse(run);
    assert.equal(parsed.id, run.id);
    assert.ok(parsed.findings.length > 0);
  }
});

test('底座的 LoopRun 在类型上可直接当作 kernel 的 RunView', () => {
  // 编译期检查：若结构不兼容，这一行会直接让 tsc 失败。
  const structural: RunView = WAGE_GAP_RUN;
  assert.equal(structural.id, WAGE_GAP_RUN.id);
});

test('插件导出的 profile 通过底座的 informationProfileSchema', () => {
  assert.ok(laborPlugin.profiles && laborPlugin.profiles.length === 1);
  const profile = laborPlugin.profiles[0]!;
  const parsed = informationProfileSchema.parse(profile);
  assert.equal(parsed.id, 'labor.intake');
  assert.ok(parsed.needs.length >= 20);
  for (const need of parsed.needs) {
    assert.ok(need.id.startsWith('labor.need.'), `需求 id 应有命名空间：${need.id}`);
    assert.ok(need.spec, `需求必须带结构化 spec：${need.id}`);
    assert.ok(need.question.length > 0 && need.reason.length > 0);
  }
});

test('工具能装进底座的 AgentToolCatalog，且顺序与 id 稳定', () => {
  const catalog = new AgentToolCatalog(laborPlugin.tools ?? []);
  const ids = catalog.list().map((tool) => tool.id);
  assert.deepEqual(ids, ['labor.checklist', 'labor.assess', 'labor.gaps', 'labor.paths', 'labor.defenses', 'labor.opinions', 'labor.amount', 'labor.deadline']);
  for (const tool of catalog.list()) {
    assert.equal(tool.effect, 'read', '插件只提供只读工具，不写案件');
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object');
  }
});

test('底座 validate 能识别插件手写的 Standard Schema', async () => {
  const catalog = new AgentToolCatalog(laborPlugin.tools ?? []);
  const checklist = catalog.get({ id: 'labor.checklist', version: 1 });

  const empty = await validate(checklist.input, {}, 'input');
  assert.equal(empty.ok, true, 'checklist 全部字段可选，空对象应通过');

  const unknownKey = await validate(checklist.input, { 无关字段: 1 }, 'input');
  assert.equal(unknownKey.ok, false, '未知字段必须被拒绝');
  if (!unknownKey.ok) assert.equal(unknownKey.error.code, 'INPUT_INVALID');
});

test('成果区块通过 outputSectionSchema，且只引用本运行内的 finding', async () => {
  assert.ok(laborPlugin.contributeOutput);
  const findingIds = new Set(WAGE_GAP_RUN.findings.map((finding) => finding.id));
  const sections = await laborPlugin.contributeOutput(WAGE_GAP_RUN);
  assert.ok(sections.length > 0, '本次运行应有可渲染的专业区块');

  const seen = new Set<string>();
  for (const section of sections) {
    const parsed = outputSectionSchema.parse(section);
    assert.ok(!seen.has(parsed.id), `区块 id 不得重复：${parsed.id}`);
    seen.add(parsed.id);
    assert.equal(parsed.provider.id, 'labor.cn');

    for (const paragraph of parsed.paragraphs) {
      assert.ok(paragraph.findingIds.length > 0, '每段必须引用出处');
      for (const id of paragraph.findingIds) assert.ok(findingIds.has(id), `引用了运行外的 finding：${id}`);
    }
    for (const table of parsed.tables) {
      for (const row of table.rows) {
        assert.ok(row.findingIds.length > 0, '每行必须引用出处');
        assert.equal(row.cells.length, table.columns.length, '单元格数与列数必须一致');
        for (const id of row.findingIds) assert.ok(findingIds.has(id), `引用了运行外的 finding：${id}`);
      }
    }
  }
});

test('按争点裁剪：只装配解除时，需求从 28 条降到 11 条', () => {
  const full = createLaborPlugin();
  const trimmed = createLaborPlugin({ issues: ['labor.termination'] });

  const fullNeeds = full.profiles?.[0]?.needs ?? [];
  const trimmedNeeds = trimmed.profiles?.[0]?.needs ?? [];
  assert.equal(fullNeeds.length, 28);
  assert.equal(trimmedNeeds.length, 11, '解除争点共 11 条需求');
  // 裁剪后仍然全部带 spec，且通过底座 schema
  const parsed = informationProfileSchema.parse(trimmed.profiles?.[0]);
  for (const need of parsed.needs) assert.ok(need.spec);
  assert.deepEqual(
    trimmedNeeds.map((need) => need.id).sort(),
    ['labor.need.tenure', 'labor.need.term-date', 'labor.need.term-lastday', 'labor.need.term-reason', 'labor.need.term.by-agreement', 'labor.need.term.by-employee', 'labor.need.term.by-employer', 'labor.need.term-form', 'labor.need.wage-base12', 'labor.need.evaluative.misconduct', 'labor.need.evaluative.fairness'].sort(),
  );
});

test('按争点裁剪：工具与成果区块只覆盖选中争点', async () => {
  const trimmed = createLaborPlugin({ issues: ['labor.termination'] });
  const catalog = new AgentToolCatalog(trimmed.tools ?? []);
  const checklist = catalog.get({ id: 'labor.checklist', version: 1 });
  const out = await validate(checklist.input, {}, 'input');
  assert.equal(out.ok, true);

  // 用解除场景运行：只应看到解除一个争点
  const sections = await trimmed.contributeOutput?.(TERMINATION_RUN);
  assert.ok(sections && sections.length > 0);
  const text = sections.flatMap((section) => (section.paragraphs ?? []).map((paragraph) => paragraph.text)).join('\n');
  assert.doesNotMatch(text, /工资支付/u, '未选中的争点不应出现在区块里');
});

test('按争点裁剪：未知或空的争点列表直接报错', () => {
  assert.throws(() => createLaborPlugin({ issues: [] }), /issues 不能为空数组/u);
  assert.throws(() => createLaborPlugin({ issues: ['labor.nope'] }), /未知争点：labor\.nope/u);
});

test('插件可通过工厂重复构造，且 id / version 稳定', () => {
  const first = createLaborPlugin();
  const second = createLaborPlugin({ version: '9.9.9' });
  assert.equal(first.id, second.id);
  assert.equal(first.version, '0.6.0', '默认版本随知识包升级');
  assert.equal(second.version, '9.9.9');
  assert.throws(() => createLaborPlugin({ stance: 'unknown' as never }), /stance|知识包/u);
});
