/**
 * 端到端接入测试：用底座真实的 createLegalAgent 装配本插件。
 *
 * 不调用模型、不写案件数据：只验证装配、工具目录与 profile 注册是否成立。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLegalAgent } from '../../底座/src/agent/engine.ts';
import type { JsonModel } from '../../底座/src/information/model.ts';
import { createLaborPlugin, createPlugin } from '../src/index.ts';

/** 只用于装配的假模型；本测试不会触发任何调用。 */
const model: JsonModel = {
  id: 'test-model',
  model: 'test-model-1',
  complete: async () => { throw new Error('本测试不应调用模型'); },
};

test('createPlugin 工厂：底座可把模型注入插件，default 导出保持兼容', async () => {
  const withModel = createPlugin({ model });
  const withoutModel = createPlugin({});
  for (const extension of [withModel, withoutModel]) {
    assert.equal(extension.id, 'labor.cn');
    assert.equal(typeof extension.version, 'string');
    assert.equal((extension.tools ?? []).length, 8, '模型只影响 opinions 工具的行为，不增删工具');
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'labor-plugin-factory-'));
  try {
    const agent = await createLegalAgent({ dataDir, model, extensions: [withModel] });
    const ids = agent.tools().map((tool) => tool.id);
    assert.ok(ids.includes('labor.opinions'));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('插件能被底座的 createLegalAgent 真实装配', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'labor-plugin-'));
  const agent = await createLegalAgent({ dataDir, model, extensions: [createLaborPlugin()] });
  try {
    const tools = agent.tools().map((tool) => tool.id);
    // 底座自带的 12 个工具仍在
    assert.ok(tools.includes('information.organize'));
    assert.ok(tools.includes('output.create'));
    assert.ok(tools.includes('material.read'));
    // 插件新增的 5 个只读工具
    for (const id of ['labor.checklist', 'labor.assess', 'labor.gaps', 'labor.amount', 'labor.deadline']) {
      assert.ok(tools.includes(id), `缺少插件工具：${id}`);
    }
    assert.equal(new Set(tools).size, tools.length, '工具 id 不得重复');
  } finally {
    await agent.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('同一底座可以同时装配两个不同部门法插件（结构不冲突）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'labor-plugin-multi-'));
  const loan = {
    id: 'loan.demo', version: '0.0.1',
    profiles: [{
      id: 'loan.intake', version: '0.0.1', description: '借用合同整理（仅用于结构验证）',
      needs: [{
        id: 'loan.need.delivery', question: '借用物是否交付？', reason: '交付是借用合同的基础事实',
        spec: { topic: 'loan.delivery', subject: null, object: null, period: null, basis: null, requiredFields: [], minimumSupport: 'statement' as const, applicable: true },
      }],
    }],
  };
  const agent = await createLegalAgent({ dataDir, model, extensions: [createLaborPlugin(), loan] });
  try {
    const tools = agent.tools().map((tool) => tool.id);
    assert.ok(tools.includes('labor.checklist'));
    assert.ok(tools.includes('information.profiles'));
  } finally {
    await agent.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('同一插件重复装配会被底座拒绝（extension id 必须唯一）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'labor-plugin-dup-'));
  await assert.rejects(
    createLegalAgent({ dataDir, model, extensions: [createLaborPlugin(), createLaborPlugin()] }),
    /AGENT_EXTENSION_DUPLICATE/u,
  );
  await rm(dataDir, { recursive: true, force: true });
});
