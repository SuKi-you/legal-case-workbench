'use strict';

// Creates a self-contained prototype page with synthetic records.
const C = {
  paper: 'F6F4EF', white: 'FFFFFF', ink: '232621', muted: '575B51',
  line: 'DEDBD0', accent: '805638', soft: 'EDE3D8', rail: 'F1EEE6',
  amber: '815018', amberSoft: 'F5EAD5', dark: '282620', document: 'FCFAF5',
};
const W = 1200;
const H = 752;
const PANEL_W = 922;
const PANEL_H = 563;
const nav = [
  { number: '01', label: '证据镜片', first: 'lens' },
  { number: '02', label: '因子对照', first: 'pay' },
  { number: '03', label: '补料轨迹', first: 'before' },
];
const states = [
  { id: 'lens', family: 0, name: 'OCR 原文', heading: '点原件，定位校对处' },
  { id: 'draft', family: 0, name: '待保存修订', heading: '点原件，定位校对处' },
  { id: 'saved', family: 0, name: 'v2 已保存', heading: '点原件，定位校对处' },
  { id: 'reference', family: 0, name: 'v1 固定引用', heading: '回看旧引用对应的文字' },
  { id: 'pay', family: 1, name: '应发与实付', heading: '先对齐范围，再判断差异' },
  { id: 'conflict', family: 1, name: '同一谈话的异说', heading: '先对齐范围，再判断差异' },
  { id: 'before', family: 2, name: '补料前', heading: '补一份材料，看到它改变了什么' },
  { id: 'after', family: 2, name: '补料后', heading: '补一份材料，看到它改变了什么' },
];
let regular;
let strong;
const edges = [];

function paint(hex) {
  const value = Number.parseInt(hex, 16);
  return [{ type: 'SOLID', color: { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 } }];
}
function frame(parent, name, x, y, w, h, fill = C.white, line = false, radius = 8, isComponent = false) {
  const node = isComponent ? figma.createComponent() : figma.createFrame();
  parent.appendChild(node);
  node.name = name;
  node.resize(w, h);
  node.x = x;
  node.y = y;
  node.fills = fill ? paint(fill) : [];
  node.cornerRadius = radius;
  node.clipsContent = false;
  if (line) { node.strokes = paint(C.line); node.strokeWeight = 1; }
  return node;
}
function label(parent, name, value, x, y, w, size = 14, color = C.ink, bold = false, align = 'LEFT') {
  const node = figma.createText();
  parent.appendChild(node);
  node.name = name;
  node.fontName = bold ? strong : regular;
  node.fontSize = size;
  node.lineHeight = { unit: 'PERCENT', value: 140 };
  node.fills = paint(color);
  node.characters = value;
  node.textAutoResize = 'HEIGHT';
  node.textAlignHorizontal = align;
  node.resize(w, Math.max(1, node.height));
  node.x = x;
  node.y = y;
  return node;
}
function rule(parent, x, y, w) {
  return frame(parent, '分隔线', x, y, w, 1, C.line, false, 0);
}
function control(parent, text, x, y, w, dest, { main = false, active = false, ghost = false, live = false } = {}) {
  const fill = main ? C.accent : active ? C.soft : ghost ? C.rail : C.white;
  const node = frame(parent, text, x, y, w, 40, fill, !main, 6);
  label(node, '操作标签', text, 8, 10, w - 16, 14, main ? C.white : active ? C.accent : C.ink, true, 'CENTER');
  if (live && dest) edges.push({ node, dest });
  return node;
}
function status(parent, name, text, y, pending = false) {
  const strip = frame(parent, name, 26, y, PANEL_W - 52, 54, pending ? C.amberSoft : C.soft, false, 6);
  label(strip, '状态说明', text, 13, 15, PANEL_W - 78, 14, pending ? C.amber : C.ink);
}
function panelTitle(parent, state, subtitle) {
  label(parent, '组件编号', nav[state.family].number + ' / ' + ['SOURCE LENS', 'FACT COMPARATOR', 'EVIDENCE IMPACT'][state.family], 26, 21, 410, 11, C.accent, true);
  label(parent, '组件标题', state.heading, 26, 44, PANEL_W - 52, 27, C.ink, true);
  label(parent, '操作说明', subtitle, 26, 88, PANEL_W - 52, 14, C.muted);
}
function lensPanel(parent, state, live) {
  const corrected = state.id === 'saved';
  const staged = state.id === 'draft';
  const history = state.id === 'reference';
  panelTitle(parent, state, history ? '固定引用定位到当时的版本，人工修订保存在另一条版本记录。' : '点击原件上的数值带入校对框，然后保存为独立版本。');
  const left = frame(parent, '原件纸面 · M02', 26, 127, 427, 289, C.white, true, 8);
  const right = frame(parent, '文字版本 · M02', 469, 127, 427, 289, C.white, true, 8);
  label(left, '原件标题', 'M02 · 原件示意', 16, 15, 395, 16, C.ink, true);
  const doc = frame(left, '工资清册', 16, 50, 395, 179, C.document, true, 3);
  label(doc, '清册标题', '星桥公司 · 工资清册', 13, 10, 368, 17, C.ink, true);
  label(doc, '登记对象', '2026 年 9 月  /  陈某 E017', 13, 37, 368, 13, C.muted);
  rule(doc, 13, 64, 368);
  label(doc, '应发项目', '应发工资', 13, 81, 136);
  control(doc, '6,000.00', 154, 71, 123, 'draft', { active: true, live: live && state.id === 'lens' });
  rule(doc, 13, 120, 368);
  label(doc, '净额项目', '应付净额', 13, 134, 136);
  label(doc, '净额金额', '5,400.00', 161, 134, 120, 15, C.ink, true);
  label(left, '原件说明', '原件所列应发工资为 6,000 元。', 16, 242, 389, 13, C.muted);

  label(right, '版本标识', history ? 'v1 · 固定引用' : corrected ? 'v2 · 已校对' : 'v1 · OCR', 16, 15, 370, 16, C.accent, true);
  label(right, '字段名', '应发工资', 16, 62, 390, 14, C.muted);
  const amount = frame(right, '校对字段', 16, 90, 182, 57, C.paper, true, 5);
  label(amount, '识别值', corrected || staged ? '6,000 元' : '8,000 元', 10, 7, 162, 29, C.ink, true);
  if (history) {
    control(right, '返回 v2', 16, 171, 111, 'saved', { main: true, live });
  } else if (corrected) {
    control(right, '回看 v1 引用', 16, 171, 139, 'reference', { live });
  } else {
    control(right, '保存为 v2', 16, 171, 115, staged ? 'saved' : null, { main: staged, ghost: !staged, live });
  }
  const hint = history ? '旧引文 R12 保留 v1 当时的 8,000 元。' : corrected ? '新底稿可引用 v2 的 6,000 元。' :
    staged ? '已从原件带入 6,000 元，等待保存。' : 'OCR 文本中的 8,000 元需要核对。';
  label(right, '版本状态', hint, 16, 230, 389, 13, C.muted);
  status(parent, '原文版本约束', history ? 'R12 仍指向 M02 v1 · 校对后形成的新引用可以指向 v2。' :
    '原件与文字修订分开保留 · 旧引用可以回到当时的文字。', 436);
}
const pairs = {
  pay: [
    { source: 'M02 · 工资表 v2', value: '6,000 元', factors: ['陈某 E017', '2026 年 9 月', '应发工资'], quote: '陈某（E017）2026 年 9 月应发工资 6000 元，应付净额 5400 元。' },
    { source: 'M03 · 付款回单', value: '5,400 元', factors: ['陈某 E017', '2026 年 9 月', '实际付款'], quote: '星桥公司向陈某账户实际支付 2026 年 9 月工资 5400 元。' },
  ],
  conflict: [
    { source: 'M01 · 陈某接案笔录', value: '陈某称曾收到口头通知', factors: ['陈某 E017', '10 月 8 日 · MT17', '肯定'], quote: '陈某称：编号 MT17 的谈话中，主管代表公司口头告知解除劳动合同。' },
    { source: 'M04 · 公司答辩', value: '公司否认发过该通知', factors: ['陈某 E017', '10 月 8 日 · MT17', '否定'], quote: '公司称：就编号 MT17 的谈话，主管没有代表公司向陈某发出解除通知。' },
  ],
};
function comparePanel(parent, state, live) {
  const conflict = state.id === 'conflict';
  panelTitle(parent, state, '对照主体、期间或事项，以及真正影响判断的字段。');
  control(parent, '应发 vs 实付', 26, 119, 125, 'pay', { active: !conflict, live: live && conflict });
  control(parent, '同一谈话的相反记载', 161, 119, 185, 'conflict', { active: conflict, live: live && !conflict });
  pairs[state.id].forEach((record, index) => {
    const card = frame(parent, record.source, 26 + index * 443, 175, 427, 282, C.white, true, 8);
    label(card, '材料来源', record.source, 15, 12, 397, 14, C.muted, true);
    label(card, '记录内容', record.value, 15, 40, 397, conflict ? 22 : 28, C.ink, true);
    const keys = conflict ? ['对象', '同一谈话', '陈述方向'] : ['主体', '工资月', '金额口径'];
    record.factors.forEach((value, i) => {
      const top = 88 + i * 33;
      rule(card, 15, top, 397);
      label(card, keys[i], keys[i], 15, top + 7, 102, 13, C.muted);
      label(card, '对照值', value, 121, top + 7, 291, 13, i === 2 ? C.accent : C.ink, i === 2);
    });
    rule(card, 15, 191, 397);
    label(card, '原文', '引用原文', 15, 203, 397, 12, C.accent, true);
    label(card, '逐字引文', record.quote, 15, 224, 397, 13, C.ink);
  });
  status(parent, '比较结论', conflict ? '同一事项 · 相反记载待核。两条说法同时保留，各自回到原文。' :
    '口径不同 · 分列保留。继续核对扣项和到账情况。', 477, conflict);
}
function impactPanel(parent, state, live) {
  const after = state.id === 'after';
  panelTitle(parent, state, '并列查看补料前后的事实因子、出处和待办。');
  control(parent, after ? '回看补料前' : '补入 M05 书面通知', 26, 119, after ? 121 : 169,
    after ? 'before' : 'after', { main: !after, live });
  const events = after ? [['10 月 8 日', 'M01 · 口头告知陈述'], ['10 月 10 日', 'M05 · 文件出具'], ['10 月 13 日', 'M05 · 文件载明生效']] :
    [['10 月 8 日', 'M01 · 口头告知陈述']];
  events.forEach(([date, origin], index) => {
    const x = 26 + index * 292;
    frame(parent, '时间线轨道', x, 182, 287, 3, index > 0 ? C.accent : C.line, false, 0);
    label(parent, '时间点', date, x, 190, 285, 14, C.ink, true);
    label(parent, '事件与来源', origin, x, 214, 285, 12, C.muted);
  });
  const ledger = frame(parent, '补料前后对照', 26, 246, 870, 173, C.white, true, 8);
  frame(ledger, '表头底', 0, 0, 870, 36, C.rail, false, 6);
  const cols = [13, 211, 532];
  ['核对项', '补料前', '补料后'].forEach((t, i) => label(ledger, t, t, cols[i], 8, 188, 13, C.muted, true));
  const rows = [
    ['生效日期', '已读材料未明确', after ? 'M05 载明 10 月 13 日' : '等待补入材料'],
    ['原口头陈述', 'M01 · 保留', after ? 'M01 原陈述继续保留' : '等待补入材料'],
    ['送达与效力', '待承办人核对', after ? '仍待承办人核对' : '等待补入材料'],
  ];
  rows.forEach((row, index) => {
    const top = 36 + index * 45;
    if (after && index === 0) frame(ledger, '日期变动底色', 1, top, 868, 45, C.soft, false, 0);
    rule(ledger, 0, top, 870);
    row.forEach((t, i) => label(ledger, '核对字段', t, cols[i], top + 11, i === 0 ? 186 : 313, 14, i === 2 && after ? C.accent : C.ink, i === 0 || (after && index === 0 && i === 2)));
  });
  if (after) {
    label(parent, 'M05 原文', 'M05 原文：本公司决定自 2026 年 10 月 13 日起解除与你的劳动合同。', 26, 434, 870, 13, C.ink);
  }
  status(parent, '下一步准备', after ? '下一步 · 核对通知送达的时间、方式与效力。' :
    '下一步 · 查找是否有明确载明解除生效时间的文件。', 477, true);
}
function panelContents(parent, state, live) {
  if (state.family === 0) lensPanel(parent, state, live);
  if (state.family === 1) comparePanel(parent, state, live);
  if (state.family === 2) impactPanel(parent, state, live);
}
function scene(page, state, i) {
  const art = frame(page, nav[state.family].number + ' · ' + state.name, (i % 3) * (W + 120), Math.floor(i / 3) * (H + 114), W, H, C.paper, false, 0);
  const mark = frame(art, '工作台标记', 26, 21, 34, 34, C.dark, false, 5);
  label(mark, '字母标记', 'E', 5, 4, 24, 18, C.white, true, 'CENTER');
  label(art, '产品名', '案卷工作台', 69, 18, 300, 17, C.ink, true);
  label(art, '英文名称', 'EVIDENCE DESK', 69, 43, 270, 10, C.muted, true);
  label(art, '演示标签', '虚构案件 / 交互原型', 924, 30, 250, 12, C.muted, false, 'RIGHT');
  rule(art, 26, 71, 1148);
  label(art, '案由路径', '案件工作区  /  劳动争议  /  交互组件', 26, 84, 616, 12, C.muted);
  label(art, '案件名称', '陈某 · 星桥公司', 26, 106, 610, 30, C.ink, true);
  const rail = frame(art, '左栏 · 材料索引', 26, 158, 211, PANEL_H, C.rail, true, 8);
  label(rail, '组名', '组件实验', 14, 18, 178, 12, C.muted, true);
  nav.forEach(({ number, label: name, first }, index) => {
    control(rail, number + '   ' + name, 13, 46 + index * 48, 185, first,
      { active: state.family === index, live: state.family !== index });
  });
  rule(rail, 13, 203, 185);
  label(rail, '索引组名', '演示材料索引', 14, 218, 178, 12, C.muted, true);
  ['M01  陈某接案笔录', 'M02  9 月工资表', 'M03  付款凭证', 'M04  公司答辩',
    'M05  书面通知 · ' + (state.id === 'after' ? '已补入' : '待补入')].forEach((entry, index) =>
    label(rail, '材料 ' + (index + 1), entry, 14, 250 + index * 30, 183, 12, index === 4 ? C.accent : C.ink));
  const panel = frame(art, '当前组件 · ' + nav[state.family].label, 252, 158, PANEL_W, PANEL_H, C.white, true, 8);
  panelContents(panel, state, true);
  return art;
}
async function fonts() {
  const list = (await figma.listAvailableFontsAsync()).map(font => font.fontName);
  for (const name of ['Microsoft YaHei', 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'SimHei', 'Inter']) {
    const available = list.filter(font => font.family === name);
    if (!available.length) continue;
    regular = available.find(font => /^(Regular|Normal|Book)$/i.test(font.style)) ?? available[0];
    strong = available.find(font => /^(SemiBold|Semibold|Bold|Medium)$/i.test(font.style)) ?? regular;
    try {
      await figma.loadFontAsync(regular);
      if (strong.style !== regular.style) await figma.loadFontAsync(strong);
      return;
    } catch { /* Try another installed family. */ }
  }
  throw new Error('未找到可用字体。请在 Figma 中启用中文字体后重试。');
}
async function main() {
  await fonts();
  const page = figma.createPage();
  page.name = '案卷工作台 · 交互组件';
  await figma.setCurrentPageAsync(page);
  const scenes = new Map(states.map((state, index) => [state.id, scene(page, state, index)]));
  for (const { node, dest } of edges) {
    const target = scenes.get(dest);
    if (!target) throw new Error('原型目标未找到：' + dest);
    await node.setReactionsAsync([{
      trigger: { type: 'ON_CLICK' },
      actions: [{
        type: 'NODE', destinationId: target.id, navigation: 'NAVIGATE',
        transition: { type: 'DISSOLVE', easing: { type: 'EASE_OUT' }, duration: 0.2 },
        preserveScrollPosition: false,
      }],
    }]);
  }
  const designY = 3 * (H + 114);
  label(page, '组件库标题', '可编辑组件 · 三组状态变体', 0, designY - 63, 860, 26, C.ink, true);
  nav.forEach(({ label: name }, family) => {
    const variants = states.filter(state => state.family === family).map((state, index) => {
      const master = frame(page, '状态=' + state.name, index * (PANEL_W + 42), designY + family * (PANEL_H + 97),
        PANEL_W, PANEL_H, C.white, true, 8, true);
      panelContents(master, state, false);
      return master;
    });
    const set = figma.combineAsVariants(variants, page);
    set.name = name + ' / 状态';
    set.x = 0;
    set.y = designY + family * (PANEL_H + 97);
  });
  page.flowStartingPoints = nav.map(({ label: name, first }) => ({ nodeId: scenes.get(first).id, name }));
  page.selection = [scenes.get('lens')];
  figma.viewport.scrollAndZoomIntoView(page.selection);
  figma.closePlugin('已新增 8 个原型画板和 3 组组件变体。点击 Present 查看。');
}
main().catch(error => {
  console.error(error);
  figma.closePlugin('原型生成未完成：' + (error instanceof Error ? error.message : String(error)));
});
