'use strict';
// Runs the generator against a small scene-graph stub. Figma renderer/runtime
// compatibility still needs a Figma Design desktop run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function check() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.editorType, ['figma']);
  assert.equal(manifest.documentAccess, 'dynamic-page');
  assert.deepEqual(manifest.networkAccess.allowedDomains, ['none']);
  let id = 0;
  const pages = [];
  function node(type) {
    return {
      type, id: String(++id), children: [], x: 0, y: 0, width: 1, height: 1,
      appendChild(child) {
        if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
        this.children.push(child);
        child.parent = this;
      },
      resize(width, height) { this.width = width; this.height = height; },
      async setReactionsAsync(reactions) { this.reactions = reactions; },
    };
  }
  const oldPage = node('PAGE');
  oldPage.name = '已有设计';
  const sentinel = node('FRAME');
  oldPage.appendChild(sentinel);
  pages.push(oldPage);
  const oldId = oldPage.id;
  let close;
  const finished = new Promise(resolve => { close = resolve; });
  const figma = {
    currentPage: oldPage,
    createPage() { const page = node('PAGE'); pages.push(page); return page; },
    async setCurrentPageAsync(page) { this.currentPage = page; },
    createFrame: () => node('FRAME'),
    createComponent: () => node('COMPONENT'),
    createText: () => node('TEXT'),
    async listAvailableFontsAsync() {
      return ['Regular', 'Bold'].map(style => ({ fontName: { family: 'Microsoft YaHei', style } }));
    },
    async loadFontAsync(font) { assert.equal(font.family, 'Microsoft YaHei'); },
    combineAsVariants(components, parent) {
      const set = node('COMPONENT_SET');
      for (const component of components) set.appendChild(component);
      parent.appendChild(set);
      return set;
    },
    viewport: { scrollAndZoomIntoView(selection) { assert.equal(selection.length, 1); } },
    closePlugin: close,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, manifest.main), 'utf8'), { figma, console });
  assert.match(await finished, /已新增 8 个原型画板/);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].id, oldId);
  assert.equal(pages[0].children[0], sentinel);
  const page = pages[1];
  const scenes = page.children.filter(item => item.type === 'FRAME');
  const sets = page.children.filter(item => item.type === 'COMPONENT_SET');
  assert.equal(scenes.length, 8);
  assert.deepEqual(sets.map(set => set.children.length), [4, 2, 2]);
  assert.equal(page.flowStartingPoints.length, 3);
  const sceneIds = new Set(scenes.map(scene => scene.id));
  function descend(item) { return [item, ...item.children.flatMap(descend)]; }
  const links = new Map(scenes.map(scene => [scene.id, descend(scene).flatMap(item => item.reactions ?? [])]));
  for (const reactions of links.values()) for (const reaction of reactions) {
    assert.equal(reaction.trigger.type, 'ON_CLICK');
    assert.equal(reaction.actions.length, 1);
    assert.equal(reaction.actions[0].type, 'NODE');
    assert.equal(reaction.actions[0].navigation, 'NAVIGATE');
    assert.ok(sceneIds.has(reaction.actions[0].destinationId));
  }
  const expected = [
    ['OCR 原文', '6,000.00', '待保存修订'],
    ['待保存修订', '保存为 v2', 'v2 已保存'],
    ['v2 已保存', '回看 v1 引用', 'v1 固定引用'],
    ['v1 固定引用', '返回 v2', 'v2 已保存'],
    ['应发与实付', '同一谈话的相反记载', '同一谈话的异说'],
    ['同一谈话的异说', '应发 vs 实付', '应发与实付'],
    ['补料前', '补入 M05 书面通知', '补料后'],
    ['补料后', '回看补料前', '补料前'],
  ];
  for (const [start, control, end] of expected) {
    const from = scenes.find(scene => scene.name.endsWith(start));
    const to = scenes.find(scene => scene.name.endsWith(end));
    assert.ok(descend(from).some(item => item.name === control && item.reactions?.[0]?.actions[0]?.destinationId === to.id), start + ' → ' + end);
  }
  const visited = new Set();
  function follow(sceneId) {
    if (visited.has(sceneId)) return;
    visited.add(sceneId);
    for (const reaction of links.get(sceneId)) follow(reaction.actions[0].destinationId);
  }
  follow(page.flowStartingPoints[0].nodeId);
  assert.equal(visited.size, 8);
  const linkCount = [...links.values()].reduce((sum, reactions) => sum + reactions.length, 0);
  console.log(JSON.stringify({ result: 'passed', mock: true, artboards: scenes.length, componentSets: sets.length,
    variants: sets.reduce((sum, set) => sum + set.children.length, 0), clickableLinks: linkCount, startPoints: 3,
    testedPaths: expected.length, originalPagePreserved: true }));
}
check().catch(error => { console.error(error); process.exitCode = 1; });
