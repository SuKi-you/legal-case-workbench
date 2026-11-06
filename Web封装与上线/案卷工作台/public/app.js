const byId = (id) => document.getElementById(id);
const dom = Object.fromEntries([
  'case-list', 'material-list', 'case-title', 'case-meta', 'folio', 'annotations',
  'notice', 'workspace-tabs', 'workspace-dialog', 'dialog-content',
].map((id) => [id, byId(id)]));

const state = {
  config: {}, cases: [], contents: null, material: null, caseId: '', materialId: '',
  view: 'materials', versionId: '', citation: null, line: null,
  runs: [], outputs: [], runId: '', node: null, busy: '', caseRequest: 0, materialRequest: 0,
  edits: new Map(),
};

const caseStates = { active: '进行中', paused: '暂停', closed: '已结案' };
const runStates = { completed: '本轮核对结束', needs_review: '待人工核对', stalled: '本轮暂止', limit_reached: '达到本轮上限' };
const versionKinds = { original: '原始文字', ocr: 'OCR 识别', revision: '人工修订' };
const conflictTypes = {
  inconsistent: '相反陈述', possible_conflict: '可能冲突', different_scope: '口径差异', insufficient_context: '上下文不足',
};
const reviewKinds = {
  new_evidence: '补入新证据', opponent_response: '收到对方答辩', hearing_preparation: '庭前准备',
};
const coverageKinds = { satisfied: '已有信息', needs_review: '待核对', needs_information: '待补充', not_applicable: '不适用' };
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
const shortDate = (date) => date ? dateFormatter.format(new Date(date)) : '';
const number = (index) => String(index + 1).padStart(2, '0');
const segment = encodeURIComponent;
const casePath = (caseId = state.caseId) => '/api/cases/' + segment(caseId);
const materialPath = (materialId = state.materialId, caseId = state.caseId) => casePath(caseId) + '/materials/' + segment(materialId);
const materialLabel = (materialId) => state.contents?.materials.find((item) => item.id === materialId)?.sourceLabel || '历史材料';
const activeCase = () => state.contents?.case;
const activeRun = () => state.runs.find((run) => run.id === state.runId);
const versions = () => state.material?.versions || [];
const activeVersion = () => versions().find((version) => version.id === state.versionId);
const editKey = (versionId) => state.caseId + '/' + versionId;
const versionName = (version) => 'V' + (versions().findIndex((entry) => entry.id === version.id) + 1) + ' · ' + versionKinds[version.kind];
const currentVersions = () => {
  const parents = new Set(versions().flatMap((version) => version.kind === 'revision' ? [version.baseVersionId] : []));
  return versions().filter((version) => !parents.has(version.id));
};

function el(tag, className = '', value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.textContent = String(value);
  return element;
}

function group(tag, className, ...children) {
  const element = el(tag, className);
  element.append(...children.filter((child) => child !== null && child !== undefined));
  return element;
}

function button(label, action, { primary = false, data = {}, disabled = false, className = '' } = {}) {
  const element = el('button', className || (primary ? 'button button-primary' : 'button'), label);
  element.type = 'button';
  if (action) element.dataset.action = action;
  Object.assign(element.dataset, data);
  element.disabled = disabled;
  return element;
}

function status(label) {
  return el('span', 'status-tag', label);
}

function setNotice(message, tone = '') {
  dom.notice.textContent = message;
  dom.notice.dataset.tone = tone;
  dom.notice.hidden = !message;
}

async function api(path, { method = 'GET', data, binary } = {}) {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: method === 'GET' ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
    body: method === 'GET' ? undefined : binary ?? JSON.stringify(data ?? {}),
  });
  const content = await response.json().catch(() => null);
  if (!response.ok) throw new Error(content?.error?.message || '请求失败（HTTP ' + response.status + '）。');
  return content;
}

function guard() {
  for (const element of document.querySelectorAll('[data-action], [data-view], button[type=submit]')) {
    const action = element.dataset.action;
    if (state.busy) {
      if (!element.disabled) {
        element.disabled = true;
        element.dataset.busyLock = 'true';
      }
    } else if (element.dataset.busyLock) {
      element.disabled = false;
      delete element.dataset.busyLock;
    }
    if (['add-material', 'case-history', 'edit-case', 'export'].includes(action) && !activeCase()) {
      element.disabled = true;
      element.dataset.noCase = 'true';
    } else if (!state.busy && element.dataset.noCase) {
      element.disabled = false;
      delete element.dataset.noCase;
    }
  }
}

async function task(message, work) {
  if (state.busy) return;
  state.busy = message;
  dom.folio.setAttribute('aria-busy', 'true');
  guard();
  setNotice(message, 'working');
  try {
    const success = await work();
    setNotice(success || '');
  } catch (error) {
    setNotice(error instanceof TypeError ? '连接工作台失败，请确认服务仍在运行。' : error.message, 'error');
    const dialogError = dom['dialog-content'].querySelector('.dialog-error');
    if (dom['workspace-dialog'].open && dialogError) {
      dialogError.textContent = dom.notice.textContent;
      dialogError.hidden = false;
    }
  } finally {
    state.busy = '';
    dom.folio.removeAttribute('aria-busy');
    guard();
  }
}

function readRememberedCase() {
  try { return localStorage.getItem('case-desk-active'); }
  catch { return null; }
}

function rememberCase(caseId) {
  try { localStorage.setItem('case-desk-active', caseId); }
  catch { /* Local storage can be disabled. */ }
}

async function refreshCases() {
  const result = await api('/api/cases');
  state.cases = result.cases;
  renderRail();
  return result;
}

async function openCase(caseId, options = {}) {
  const changing = caseId !== state.caseId;
  const token = ++state.caseRequest;
  state.caseId = caseId;
  if (changing) {
    state.contents = null;
    state.material = null;
    state.materialId = '';
    state.versionId = '';
    state.citation = null;
    state.line = null;
    state.runId = '';
    state.runs = [];
    state.outputs = [];
    state.node = null;
    state.view = 'materials';
    render();
  }
  if (!caseId) return;
  const path = casePath(caseId);
  const [contents, runResult, outputResult] = await Promise.all([
    api(path), api(path + '/runs'), api(path + '/outputs'),
  ]);
  if (token !== state.caseRequest) return;
  state.contents = contents;
  state.runs = [...runResult.runs].sort((first, next) => String(next.finishedAt || next.createdAt).localeCompare(String(first.finishedAt || first.createdAt)));
  state.outputs = outputResult.outputs;
  if (!state.runs.some((run) => run.id === state.runId)) state.runId = state.runs[0]?.id || '';
  if (state.node && ![state.node.baselineRunId, state.node.currentRunId].every((id) => state.runs.some((run) => run.id === id))) state.node = null;
  rememberCase(caseId);
  const materialId = options.materialId || state.materialId;
  const selection = contents.materials.find((item) => item.id === materialId) || contents.materials[0];
  if (selection) {
    await openMaterial(selection.id, { versionId: options.versionId, keepSelection: options.keepSelection });
  } else {
    state.materialId = '';
    state.material = null;
    state.versionId = '';
    state.citation = null;
    state.line = null;
  }
  render();
}

async function openMaterial(materialId, options = {}) {
  const caseToken = state.caseRequest;
  const materialToken = ++state.materialRequest;
  const material = await api(materialPath(materialId));
  if (caseToken !== state.caseRequest || materialToken !== state.materialRequest) return;
  const oldSelection = state.materialId === materialId && options.keepSelection ? state.versionId : '';
  state.material = material;
  state.materialId = materialId;
  state.versionId = material.versions.find((version) => version.id === (options.versionId || oldSelection))?.id || material.versions.at(-1)?.id || '';
  state.citation = options.citation || null;
  state.line = null;
}

function railButton(container, label, action, id, selected, meta, detail) {
  const entry = button(label, action, { data: { id }, className: 'rail-item' });
  if (selected) {
    entry.classList.add('is-selected');
    entry.setAttribute('aria-current', 'true');
  }
  if (meta) entry.prepend(el('span', 'rail-number', meta));
  if (detail) entry.append(el('small', 'case-code', detail));
  if (['UL', 'OL'].includes(container.tagName)) container.append(group('li', '', entry));
  else container.append(entry);
}

function renderRail() {
  dom['case-list'].replaceChildren();
  const caseLabels = new Map();
  const labelKey = (record) => JSON.stringify([record.title, record.caseNumber]);
  for (const record of state.cases) {
    const key = labelKey(record);
    caseLabels.set(key, (caseLabels.get(key) || 0) + 1);
  }
  for (const record of state.cases) {
    const sameLabel = caseLabels.get(labelKey(record)) > 1;
    const detail = [record.caseNumber, sameLabel ? record.id.slice(0, 8) : ''].filter(Boolean).join(' · ');
    railButton(dom['case-list'], record.title, 'open-case', record.id, record.id === state.caseId, null, detail);
  }
  if (!state.cases.length) railEmpty(dom['case-list'], '暂无案件');
  dom['material-list'].replaceChildren();
  const materials = state.contents?.materials || [];
  const files = state.contents?.files || [];
  materials.forEach((item, index) => railButton(dom['material-list'], item.sourceLabel, 'open-material', item.id, item.id === state.materialId, number(index)));
  files.forEach((item, index) => railButton(dom['material-list'], item.sourceLabel, 'open-attachment', item.id, false, number(materials.length + index)));
  if (!materials.length && !files.length) railEmpty(dom['material-list'], '暂无材料');
}

function railEmpty(container, label) {
  container.append(el(['UL', 'OL'].includes(container.tagName) ? 'li' : 'p', 'rail-empty', label));
}

function paper(kicker, title, ...body) {
  const record = activeCase();
  const page = group('article', 'folio document-page',
    group('header', 'folio-head',
      el('p', 'folio-kicker', record ? '劳动争议  /  案卷' + (record.caseNumber ? ' ' + record.caseNumber : '') : kicker),
      el('h1', 'folio-title', record?.title || title)),
  );
  if (record) {
    page.append(el('p', 'folio-meta', kicker), el('h2', 'document-title', title));
  }
  page.append(group('div', 'folio-content', ...body.filter(Boolean)));
  if (record) {
    const ordinal = state.contents.materials.findIndex((item) => item.id === state.materialId);
    page.append(group('footer', 'folio-footer', el('span', '', '案件卷宗'),
      state.view === 'materials' && ordinal >= 0
        ? el('span', '', number(ordinal) + ' / ' + number(state.contents.materials.length - 1))
        : null));
  }
  return page;
}

function annotation(title, kicker, ...body) {
  return group('section', 'annotation', el('h2', 'annotation-title', title),
    kicker ? el('p', 'annotation-kicker', kicker) : null, ...body);
}

function originalText(value, citation) {
  const paragraph = el('pre', 'source-text');
  if (!citation) {
    paragraph.textContent = value;
    return paragraph;
  }
  const mark = el('mark', 'source-mark', value.slice(citation.start, citation.end));
  mark.dataset.annotationAnchor = 'source';
  paragraph.append(value.slice(0, citation.start), mark, value.slice(citation.end));
  return paragraph;
}

function imageDocument(material) {
  const image = el('img', 'original-image');
  image.src = material.originalUrl || materialPath(material.material.id) + '/original';
  image.alt = material.material.sourceLabel + '原件';
  const overlays = el('div', 'ocr-overlays');
  const figure = group('figure', 'source-figure', group('div', 'source-image-frame', image, overlays));
  const ocr = versions().findLast((version) => version.kind === 'ocr');
  if (!ocr?.lines.length) return figure;
  const markLines = () => {
    const { naturalWidth, naturalHeight } = image;
    if (!naturalWidth || !naturalHeight) return;
    ocr.lines.forEach(({ box, text }, index) => {
      if (box.x1 <= box.x0 || box.y1 <= box.y0 || !text.trim()) return;
      const mark = button('', 'pick-ocr-line', { className: 'ocr-hit', data: { index } });
      mark.setAttribute('aria-label', '校对图中文字 ' + (index + 1) + '：' + text);
      mark.setAttribute('aria-pressed', String(index === state.line));
      if (index === state.line) mark.dataset.annotationAnchor = 'source';
      mark.title = text;
      Object.assign(mark.style, {
        left: (100 * box.x0 / naturalWidth) + '%',
        top: (100 * box.y0 / naturalHeight) + '%',
        width: (100 * (box.x1 - box.x0) / naturalWidth) + '%',
        height: (100 * (box.y1 - box.y0) / naturalHeight) + '%',
      });
      overlays.append(mark);
    });
    guard();
  };
  if (image.complete) markLines();
  else image.addEventListener('load', markLines, { once: true });
  return figure;
}

function revisionForm(version) {
  const form = el('form', 'form-stack annotation-form');
  form.dataset.form = 'revision';
  const label = el('label', 'field', '可编辑文字');
  const textarea = el('textarea', 'revision-text');
  textarea.name = 'text';
  textarea.rows = 7;
  textarea.spellcheck = false;
  const key = editKey(version.id);
  textarea.value = state.edits.get(key) ?? version.text;
  label.append(textarea);
  textarea.addEventListener('input', () => {
    if (textarea.value === version.text) state.edits.delete(key);
    else state.edits.set(key, textarea.value);
  });
  const submit = button('保存修订', null, { primary: true });
  submit.type = 'submit';
  const note = input('修订说明（可选）', 'note', { maxLength: 300 });
  form.append(label, note, submit);
  return form;
}

function renderMaterials() {
  const material = state.material;
  if (!material) {
    dom.folio.replaceChildren(paper('接案与材料整理', '材料卷宗', group('div', 'empty-state',
      el('p', '', '添加接案笔录、工资清册或其他材料。'),
      button('添加材料', 'add-material', { primary: true }),
    )));
    dom.annotations.replaceChildren(annotation('核对批注', '等待第一份材料',
      el('p', '', '原件、识别文字和人工修订将按版本保存在当前案件。')));
    return;
  }
  const entry = material.material;
  const ordinal = state.contents.materials.findIndex((item) => item.id === entry.id);
  const version = activeVersion();
  const displayCitation = state.citation;
  const original = entry.original.kind === 'image'
    ? imageDocument(material)
    : originalText(material.text ?? versions().find((item) => item.kind === 'original')?.text ?? '');
  const body = displayCitation
    ? group('div', 'source-reference-panel', el('p', 'annotation-kicker', '固定出处 · ' + versionName(version)),
      originalText(version.text, displayCitation), button('返回原件', 'clear-citation'))
    : original;
  dom.folio.replaceChildren(paper('材料 ' + number(ordinal) + '  ·  ' + (displayCitation ? '引用版本' : '原件'),
    entry.sourceLabel, body));
  const lastAttempt = material.ocrAttempts?.at(-1);
  const controls = group('div', 'annotation-actions',
    entry.original.kind === 'image' && !version ? button('运行 OCR', 'ocr', { primary: true }) : null,
    versions().length ? button('文字版本', 'case-history') : null,
    downloadLink(material.originalUrl || materialPath() + '/original', '下载原件'),
  );
  const readOnly = version && !currentVersions().some((item) => item.id === version.id);
  const fields = version
    ? group('div', 'annotation-fields',
      el('p', 'annotation-kicker', versionName(version)),
      state.line === null ? null : el('p', 'ocr-line-note', versions().findLast((item) => item.kind === 'ocr')?.lines[state.line]?.text || ''),
      readOnly ? group('div', 'historical-version',
        el('p', 'muted', '历史版本，供核对旧引用。'),
        originalText(version.text),
        button('查看当前版本', 'open-version', { data: { id: currentVersions().at(-1).id } }),
      ) : revisionForm(version))
    : el('p', 'muted', '识别原件后，可以在这里直接校对文字。');
  dom.annotations.replaceChildren(annotation('核对批注', (displayCitation ? '固定出处' : state.line === null ? number(ordinal) + '  ·  文字核对' : 'OCR 行核对'),
    fields, controls,
    lastAttempt?.status === 'failed' ? el('p', 'warning-note', '最近一次 OCR 未取得文字：' + lastAttempt.error.message) : null,
    el('hr', 'section-rule'),
    button('运行接案核对', 'run-intake', { disabled: !state.config.modelConfigured }),
    state.config.modelConfigured ? null : el('p', 'muted', '服务端配置 DeepSeek 后可运行接案核对。'),
  ));
  if (displayCitation || state.line !== null) {
    const note = dom.annotations.querySelector('.annotation-kicker');
    note.prepend(el('span', 'annotation-index', displayCitation ? '01' : number(state.line)));
    note.dataset.annotationAnchor = 'note';
  }
}

function citeButton(citation) {
  const target = button(materialLabel(citation.materialId) + ' · 查看出处', null, { className: 'citation' });
  target.addEventListener('click', () => task('定位引用原文…', async () => {
    if (!state.contents.materials.some((item) => item.id === citation.materialId)) {
      throw new Error('该材料目前不在案件中，可在保存点中恢复后查看。');
    }
    await openMaterial(citation.materialId, { versionId: citation.versionId });
    const version = activeVersion();
    if (!version || version.id !== citation.versionId || version.textSha256 !== citation.textSha256 ||
      version.text.slice(citation.start, citation.end) !== citation.quote) {
      throw new Error('当前案件无法复核这条固定版本引用。');
    }
    state.citation = citation;
    state.view = 'materials';
    if (dom['workspace-dialog'].open) closeDialog();
    render();
    dom.folio.querySelector('mark')?.scrollIntoView({ block: 'nearest' });
    return '已定位至材料原文的固定版本。';
  }));
  return target;
}

function findingBlock(statement, citations, className = 'finding') {
  return group('article', className, el('p', '', statement), ...citations.map((citation) => (
    group('blockquote', 'evidence-quote', el('p', '', citation.quote), citeButton(citation))
  )));
}

function resultSection(label, ...children) {
  return group('section', 'result-section', el('h3', '', label), ...children);
}

function runChoice(name, value, label = '核对轮次') {
  return select(label, name, state.runs.map((run) => [run.id, shortDate(run.finishedAt || run.createdAt) + ' · ' + run.goal + ' · ' + (runStates[run.status] || run.status)]), value);
}

function renderDraft() {
  const run = activeRun();
  const draftControl = button('运行接案核对', 'run-intake', { primary: true, disabled: !state.config.modelConfigured });
  if (!run) {
    dom.folio.replaceChildren(paper('接案与材料整理', '接案底稿', group('div', 'empty-state',
      el('p', '', '接案核对生成的事实、引用及待核事项会在这里列出。'), draftControl)));
    dom.annotations.replaceChildren(annotation('接案底稿', '劳动法插件',
      el('p', '', state.config.modelConfigured ? '先整理现有材料，核对后可保存并导出底稿。' : '服务端配置 DeepSeek 后可运行接案核对。')));
    return;
  }
  const findings = run.findings || [];
  const coverage = run.information?.needs || [];
  const conflicts = run.information?.conflicts || [];
  const pending = run.professionalReview?.actions || [];
  const materialIds = new Set(run.sources.map((source) => source.materialId));
  const outsideRun = state.contents.materials.filter((item) => !materialIds.has(item.id));
  const files = state.contents.files;
  const readGaps = coverage.filter((item) => item.unread.length && item.satisfaction !== 'not_applicable');
  const selection = runChoice('runSelection', run.id);
  selection.querySelector('select').addEventListener('change', (event) => {
    state.runId = event.target.value;
    render();
    dom.annotations.querySelector('[name=runSelection]')?.focus();
  });
  const timeline = findings.filter((finding) => finding.record?.time?.start)
    .toSorted((first, next) => first.record.time.start.localeCompare(next.record.time.start));
  dom.folio.replaceChildren(paper('接案与材料整理  ·  ' + shortDate(run.finishedAt || run.createdAt),
    '接案底稿', el('p', 'folio-meta', run.goal), status(runStates[run.status] || run.status), el('p', 'muted', run.reason),
    resultSection('材料出处与事实', ...(findings.length ? findings.map((item) => findingBlock(item.statement, item.citations)) : [el('p', '', '本轮暂无可引用的事实。')])),
    timeline.length ? resultSection('事件时间线', ...timeline.map((item) => (
      group('p', 'timeline-entry', el('time', '', item.record.time.start), ' · ' + item.statement)
    ))) : null,
    conflicts.length ? resultSection('跨材料对照', ...conflicts.map((item) => (
      group('div', 'comparison-entry', status(conflictTypes[item.classification]), el('p', '', item.reason),
        group('div', 'comparison-pair', ...item.findingIds.map((id) => findings.find((finding) => finding.id === id))
          .filter(Boolean).map((finding) => findingBlock(finding.statement, finding.citations))))
    ))) : null,
    coverage.length ? resultSection('专业事项核对', ...coverage.map((item) => (
      group('div', 'record-entry',
        el('h4', '', run.needs?.find((need) => need.id === item.needId)?.question || item.needId),
        status(coverageKinds[item.satisfaction]), el('p', '', item.reason))
    ))) : null,
  ));
  dom.annotations.replaceChildren(annotation('接案底稿', '已保存核对轮次', selection,
    group('div', 'annotation-actions', draftControl, button('导出底稿', 'export')),
    (outsideRun.length || files.length || readGaps.length) ? resultSection('材料范围',
      ...outsideRun.map((item) => el('p', 'warning-note', '未纳入本轮：' + item.sourceLabel)),
      ...files.map((item) => el('p', 'warning-note', '当前案卷未解析附件：' + item.sourceLabel)),
      ...readGaps.map((item) => {
        const question = run.needs?.find((need) => need.id === item.needId)?.question || item.needId;
        return el('p', 'warning-note', question + ' · 未读 ' + item.unread.length + ' 份材料文字');
      }),
    ) : null,
    pending.length ? resultSection('待办与人工核对', ...pending.map((item) => (
      group('div', 'record-entry', el('p', '', item.instruction), el('p', 'muted', item.reason))
    ))) : el('p', 'muted', '本轮专业审查未列出后续动作。'),
  ));
}

function renderNodes() {
  const node = state.node;
  const ready = state.runs.length > 0;
  const compare = button('对照核对轮次', 'review-node', { primary: true, disabled: !ready });
  if (!node) {
    dom.folio.replaceChildren(paper('关键节点审查与准备', '关键节点', group('div', 'empty-state',
      el('p', '', ready ? '选择已保存的核对轮次，查看事实、出处与待办。补料或答辩可对照前后两轮，庭前准备可使用同一轮。' : '请先运行接案核对并保存结果。'),
      ready ? compare : button('查看接案底稿', 'show-draft'),
    )));
    dom.annotations.replaceChildren(annotation('节点准备', '选择工作节点', el('p', '', '支持新证据、对方答辩和庭前准备。')));
    return;
  }
  const sourceChanges = {
    added: '新增', version_changed: '文字版本变化', left_selection: '未纳入本轮',
  };
  const factChanges = { new_record: '新增记录', evidence_changed: '出处有变化', not_carried_forward: '未沿用' };
  const scopeWarnings = [
    ['缺少预期版本', node.scope?.missingSources?.length],
    ['额外版本', node.scope?.unexpectedSources?.length],
    ['未读取材料', node.scope?.unreadMaterialIds?.length],
    ['未解析附件', node.scope?.unparsedAttachmentIds?.length],
  ].filter(([, count]) => count);
  dom.folio.replaceChildren(paper('关键节点审查与准备', reviewKinds[node.kind],
    status(node.status === 'requires_review' ? '有事项待核' : '可进入人工复核'),
    node.scope?.checked ? null : el('p', 'warning-note', '应审材料范围尚未核对。'),
    scopeWarnings.length ? resultSection('范围提示', ...scopeWarnings.map(([label, count]) => el('p', '', label + ' ' + count + ' 项'))) : null,
    resultSection('材料与文字版本', ...(node.sources.length ? node.sources.map((item) => (
      group('p', 'timeline-entry', status(sourceChanges[item.kind]), ' ' + materialLabel(item.materialId))
    )) : [el('p', '', '两轮纳入的材料版本相同。')])),
    resultSection('事实变化', ...(node.facts.length ? node.facts.map((item) => group('div', 'comparison-entry',
      status(factChanges[item.kind]), el('p', '', item.reason),
      group('div', 'comparison-pair',
        resultSection('上一轮', ...item.before.map((finding) => findingBlock(finding.statement, finding.citations))),
        resultSection('当前轮', ...item.after.map((finding) => findingBlock(finding.statement, finding.citations))),
      ))) : [el('p', '', '没有检测到事实变化。')])),
    node.conflicts.length ? resultSection('冲突与差异变化', ...node.conflicts.map((item) => group('article', 'comparison-entry',
      item.before ? group('div', 'record-entry', status('上一轮 · ' + conflictTypes[item.before.classification]), el('p', '', item.before.reason),
        ...item.before.evidence.map((finding) => findingBlock(finding.statement, finding.citations))) : null,
      item.after ? group('div', 'record-entry', status('当前轮 · ' + conflictTypes[item.after.classification]), el('p', '', item.after.reason),
        ...item.after.evidence.map((finding) => findingBlock(finding.statement, finding.citations))) : null,
    ))) : null,
  ));
  dom.annotations.replaceChildren(annotation('节点准备', reviewKinds[node.kind],
    group('div', 'annotation-actions', compare, button('导出底稿', 'export')),
    ...node.preparations.map((item) => group('article', 'record-entry', el('p', '', item.instruction), el('p', 'muted', item.reason))),
  ));
}

function render() {
  renderRail();
  const record = activeCase();
  dom['case-title'].textContent = record?.title || '案卷工作台';
  dom['case-meta'].textContent = record ? [record.caseNumber, caseStates[record.status], record.stage].filter(Boolean).join('  /  ') : '案件工作区';
  dom['workspace-tabs'].querySelectorAll('[data-view]').forEach((tab) => {
    const selected = tab.dataset.view === state.view;
    tab.classList.toggle('is-selected', selected);
    tab.setAttribute('aria-pressed', String(selected));
  });
  if (!record) {
    dom.folio.replaceChildren(paper('法律争议  /  案卷工作台', state.caseId ? '正在打开案件' : '从一宗案件开始',
      group('div', 'empty-state', el('p', '', '从左侧打开案卷，或新建案件并登记第一份材料。'),
        button('新建案件', 'new-case', { primary: true }))));
    dom.annotations.replaceChildren(annotation('核对批注', '案卷边栏', el('p', '', '打开材料后，在这里对照原件、修订文字和查找出处。')));
  } else if (state.view === 'nodes') renderNodes();
  else if (state.view === 'draft') renderDraft();
  else renderMaterials();
  guard();
}

function input(label, name, { value = '', required = false, maxLength, type = 'text', accept, rows } = {}) {
  const control = el(rows ? 'textarea' : 'input');
  control.name = name;
  if (rows) control.rows = rows;
  else control.type = type;
  if (accept) control.accept = accept;
  if (value) control.value = value;
  if (maxLength) control.maxLength = maxLength;
  control.required = required;
  return group('label', 'field', el('span', 'field-label', label), control);
}

function select(label, name, options, selected) {
  const control = el('select');
  control.name = name;
  for (const [value, text] of options) {
    const option = el('option', '', text);
    option.value = value;
    option.selected = value === selected;
    control.append(option);
  }
  return group('label', 'field', el('span', 'field-label', label), control);
}

function formContent(kind, submitLabel, ...fields) {
  const error = el('p', 'dialog-error');
  error.hidden = true;
  error.setAttribute('role', 'alert');
  const submit = button(submitLabel, null, { primary: true });
  submit.type = 'submit';
  const form = group('form', 'form-stack', ...fields, error, group('div', 'dialog-actions',
    button('取消', 'close-dialog'), submit));
  form.dataset.form = kind;
  return form;
}

function showDialog(title, ...content) {
  const heading = el('h2', '', title);
  heading.id = 'dialog-title';
  const close = button('×', 'close-dialog', { className: 'dialog-close' });
  close.setAttribute('aria-label', '关闭');
  dom['dialog-content'].replaceChildren(group('header', 'dialog-header', heading, close), ...content.filter(Boolean));
  const dialog = dom['workspace-dialog'];
  if (!dialog.open) dialog.showModal();
  else dom['dialog-content'].querySelector('input,select,button')?.focus();
  guard();
}

function closeDialog() {
  dom['workspace-dialog'].close();
}

function openCreateCase() {
  showDialog('新建案件', formContent('create-case', '创建案件',
    input('案件名称', 'title', { required: true, maxLength: 200 }),
    input('案件编号（可选）', 'caseNumber', { maxLength: 100 }),
    input('案件备注（可选）', 'description', { rows: 3, maxLength: 2000 }),
  ));
}

function openEditCase() {
  const record = activeCase();
  showDialog('标记案件进度', formContent('edit-case', '保存进度',
    input('案件名称', 'title', { required: true, maxLength: 200, value: record.title }),
    input('当前阶段', 'stage', { required: true, maxLength: 100, value: record.stage }),
    select('状态', 'status', Object.entries(caseStates), record.status),
  ));
}

function openAddMaterial() {
  const extensions = state.config.acceptedUploads || ['.txt', '.png', '.jpg', '.jpeg'];
  const type = select('添加方式', 'uploadMode', [['file', '上传文件'], ['text', '录入文字']], 'file');
  const source = input('材料名称', 'sourceLabel', { required: true, maxLength: 200 });
  const file = input('文件（' + extensions.join('、') + '）', 'file', {
    type: 'file', accept: extensions.join(','), required: true,
  });
  const text = input('材料文字', 'text', { rows: 7, maxLength: 200000 });
  text.hidden = true;
  const update = () => {
    const fileMode = type.querySelector('select').value === 'file';
    file.hidden = !fileMode;
    text.hidden = fileMode;
    file.querySelector('input').required = fileMode;
    text.querySelector('textarea').required = !fileMode;
  };
  type.addEventListener('change', update);
  file.addEventListener('change', () => {
    const name = source.querySelector('input');
    if (!name.value.trim()) name.value = file.querySelector('input').files[0]?.name.replace(/\.[^.]+$/, '') || '';
  });
  showDialog('添加材料', formContent('add-material', '保存材料', type, source, file, text,
    el('p', 'muted', 'TXT、PNG 和 JPEG 可整理为文字。PDF 和 DOCX 作为原件附件保存，需要另行录入可核对的文字。')));
}

async function openRunIntake() {
  const { materials } = await api(casePath() + '/sources');
  const hasText = materials.some((item) => item.versions.length);
  if (!hasText) throw new Error('请先添加文字材料，或识别图片后再核对。');
  const options = [el('p', 'muted', '将下列所选版本的文字与本轮核对任务发送给 DeepSeek。')];
  const consent = el('input');
  consent.type = 'checkbox';
  consent.name = 'consent';
  consent.required = true;
  const materialOptions = materials.map((item) => {
    if (!item.versions.length) return el('p', 'muted', item.sourceLabel + ' · 无文字，本轮未读取');
    return group('div', 'record-entry',
      select(item.sourceLabel + ' · 文字版本', 'version:' + item.materialId,
        item.versions.map((version) => [version.id, versionKinds[version.kind] + ' · ' + shortDate(version.createdAt) + (version.note ? ' · ' + version.note : '')]),
        item.versions.at(-1).id),
      select('来源（可选）', 'source:' + item.materialId,
        [['', '由材料文字判断'], ['party_statement', '当事人陈述'], ['document_record', '文件记载']], ''));
  });
  if (materialOptions.length) {
    const scope = group('details', 'source-kind-details', el('summary', '', '材料与文字版本'), ...materialOptions);
    scope.open = true;
    options.push(scope);
  }
  const retry = state.runs.find((run) => run.status === 'completed' || run.status === 'needs_review');
  if (retry) {
    const reuse = el('input');
    reuse.type = 'checkbox';
    reuse.name = 'reuse';
    reuse.value = retry.id;
    options.push(group('label', 'check-field', reuse, el('span', '', '复用上一轮已核对的相同材料版本')));
  }
  showDialog('运行接案核对', formContent('run-intake', '确认并运行',
    input('本轮关注事项（可选）', 'goal', { rows: 3, maxLength: 200 }),
    ...options, group('label', 'check-field', consent, el('span', '', '我确认可以将选中的材料文字提交给 DeepSeek'))));
}

function openNodeReview() {
  showDialog('对照核对轮次', formContent('review-node', '生成节点对照',
    select('关键节点', 'kind', Object.entries(reviewKinds), state.node?.kind || (state.runs.length === 1 ? 'hearing_preparation' : 'new_evidence')),
    runChoice('baselineRunId', state.node?.baselineRunId || state.runs[1]?.id || state.runs[0].id, '上一轮核对'),
    runChoice('currentRunId', state.node?.currentRunId || state.runs[0].id, '当前轮核对'),
  ));
}

const outputIdOf = (output) => output.outputId || output.manifest?.outputId;
const outputRunOf = (output) => output.runId || output.manifest?.runId;
const outputDateOf = (output) => output.createdAt || output.manifest?.createdAt;

function downloadLink(path, title) {
  const link = el('a', 'button', title);
  link.href = path;
  link.download = '';
  return link;
}

function openExport() {
  const node = state.view === 'nodes' ? state.node : null;
  const prior = state.outputs.filter((item) => !node || outputRunOf(item) === node.baselineRunId)
    .map((item) => [outputIdOf(item), shortDate(outputDateOf(item))]);
  const run = activeRun();
  const fields = [];
  const selectedRun = node?.currentRunId || run?.id;
  if (selectedRun) {
    fields.push(runChoice('runId', selectedRun));
    if (prior.length) fields.push(select('对照旧底稿（可选）', 'previousOutputId', [['', node ? '按节点基线自动选取' : '仅导出本轮'], ...prior], ''));
    if (node) {
      const withNode = el('input');
      withNode.name = 'withNode';
      withNode.type = 'checkbox';
      withNode.checked = true;
      fields.push(group('label', 'check-field', withNode, el('span', '', '包含当前关键节点对照')));
    }
  }
  const saved = [...state.outputs].reverse().map((item) => {
    const url = casePath() + '/outputs/' + segment(outputIdOf(item)) + '/';
    return group('div', 'record-entry', el('p', '', shortDate(outputDateOf(item))),
      group('div', 'annotation-actions',
        button('查看底稿', 'open-output', { data: { id: outputIdOf(item) } }),
        downloadLink(url + 'docx', '下载 Word'), downloadLink(url + 'md', '下载 Markdown'), downloadLink(url + 'json', '下载 JSON')));
  });
  showDialog('导出底稿',
    selectedRun ? formContent('export', '生成并保存底稿', ...fields) : el('p', '', '完成一次接案核对后，可以生成底稿。'),
    saved.length ? resultSection('已保存底稿', ...saved) : null);
}

async function openSavedOutput(outputId) {
  const { draft, markdown, currentInputMatches, analysisCoversCurrentInput, sourceCoverage } =
    await api(casePath() + '/outputs/' + segment(outputId));
  const coverage = [
    ...sourceCoverage.unreadMaterialIds.map((id) => '未纳入当前文字版本：' + materialLabel(id)),
    ...sourceCoverage.ambiguousMaterialIds.map((id) => '存在多个当前文字分支：' + materialLabel(id)),
    ...sourceCoverage.unparsedAttachmentIds.map((id) => '未解析附件：' + (state.contents.files.find((item) => item.id === id)?.sourceLabel || '原件附件')),
  ];
  let nodeButton;
  if (draft.nodeReview) {
    nodeButton = button('查看已保存节点对照', null);
    nodeButton.addEventListener('click', () => {
      state.node = draft.nodeReview;
      state.view = 'nodes';
      closeDialog();
      render();
    });
  }
  showDialog('已保存底稿',
    el('p', 'folio-meta', shortDate(draft.createdAt) + ' · ' + draft.goal),
    el('p', '', draft.runReason),
    currentInputMatches ? null : el('p', 'warning-note', '保存底稿后案卷有更新，以下是当时的整理结果。'),
    analysisCoversCurrentInput ? null : el('p', 'warning-note', '底稿尚未覆盖全部当前材料或核对事项。'),
    coverage.length ? group('ul', 'rollback-list', ...coverage.map((message) => el('li', '', message))) : null,
    nodeButton,
    draft.findings.length ? resultSection('原文与出处', ...draft.findings.map((item) => findingBlock(item.statement, item.citations))) : null,
    group('details', 'record-entry', el('summary', '', '展开完整底稿'), originalText(markdown)),
    button('返回导出记录', 'export'),
  );
}

function versionHistory() {
  if (!versions().length) return null;
  return resultSection('当前材料的文字版本', ...versions().map((item) => (
    group('div', 'record-entry', status(versionName(item)), el('p', 'muted', shortDate(item.createdAt) + (item.note ? ' · ' + item.note : '')),
      button(item.id === state.versionId ? '当前版本' : '查看此版本', 'open-version', { data: { id: item.id }, disabled: item.id === state.versionId }))
  )));
}

async function openHistory() {
  const result = await api(casePath() + '/checkpoints');
  const checkpoints = result.checkpoints || [];
  const entries = checkpoints.map((item) => group('div', 'record-entry',
    el('p', '', item.label), el('p', 'muted', shortDate(item.createdAt) + ' · 修订 ' + item.sourceRevision),
    button('预览恢复', 'preview-rollback', { data: { id: item.id } })));
  showDialog('版本记录', versionHistory(),
    resultSection('案件保存点', entries.length ? group('div', 'record-list', ...entries) : el('p', 'muted', '暂无保存点。'),
      formContent('checkpoint', '创建保存点', input('保存点名称', 'label', { required: true, maxLength: 200 }))));
}

function openRollback(preview) {
  const fields = { stage: '阶段', status: '状态', title: '案名', description: '备注', caseNumber: '编号' };
  const entries = (preview.fields || []).map((item) => el('li', '',
    (fields[item.field] || item.field) + '：' + (caseStates[item.before] || item.before || '空') + ' → ' + (caseStates[item.after] || item.after || '空')));
  const names = { materials: '材料', files: '附件', versions: '文字版本', ocrAttempts: '识别结果',
    references: '引用', loopRuns: '核对轮次', outputs: '底稿', executionSnapshots: '执行记录' };
  for (const [key, label] of Object.entries(names)) {
    const out = preview[key + 'Leaving']?.length || 0;
    const back = preview[key + 'Returning']?.length || 0;
    if (out || back) entries.push(el('li', '', label + '：移出当前案卷 ' + out + ' 项，恢复 ' + back + ' 项'));
  }
  const form = formContent('rollback', '确认恢复整个案件',
    el('p', '', '将案件恢复到该保存点，并自动保留回退前的状态。'),
    entries.length ? group('ul', 'rollback-list', ...entries) : el('p', '', '当前状态与保存点一致。'),
  );
  form.dataset.preview = JSON.stringify({
    checkpointId: preview.checkpointId, expectedRevision: preview.expectedRevision, previewToken: preview.token,
  });
  showDialog('恢复预览', form);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.ceil(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function encodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts = [];
  for (let index = 0; index < bytes.length; index += 8192) {
    parts.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  }
  return btoa(parts.join(''));
}

async function uploadInParts(file, sourceLabel, partBytes) {
  const path = casePath() + '/upload-parts/' + crypto.randomUUID();
  const partCount = Math.ceil(file.size / partBytes);
  for (let index = 0; index < partCount; index += 1) {
    setNotice('正在上传材料（' + (index + 1) + '/' + partCount + '）…', 'working');
    const binary = file.slice(index * partBytes, (index + 1) * partBytes, 'application/octet-stream');
    await api(path + '/' + index, { method: 'POST', binary });
  }
  setNotice('正在保存材料…', 'working');
  return api(path, { method: 'POST', data: { sourceLabel, fileName: file.name, partCount, byteLength: file.size } });
}

async function submitForm(form, data) {
  const value = (key) => String(data.get(key) || '').trim();
  const post = (path, request) => api(path, { method: 'POST', data: request });
  switch (form.dataset.form) {
    case 'create-case': {
      const record = await post('/api/cases', {
        title: value('title'), caseNumber: value('caseNumber') || undefined, description: value('description') || undefined,
      });
      closeDialog();
      await refreshCases();
      await openCase(record.id);
      return '已创建案件。';
    }
    case 'edit-case': {
      await api(casePath(), { method: 'PATCH', data: {
        expectedRevision: activeCase().revision, title: value('title'), stage: value('stage'), status: value('status'),
      } });
      closeDialog();
      await refreshCases();
      await openCase(state.caseId, { keepSelection: true });
      return '案件进度已保存。';
    }
    case 'add-material': {
      const request = { sourceLabel: value('sourceLabel') };
      let material;
      if (value('uploadMode') === 'text') {
        request.text = String(data.get('text'));
        material = await post(casePath() + '/materials', request);
      } else {
        const file = data.get('file');
        if (!file?.size) throw new Error('请选择非空文件。');
        const max = state.config.maxUploadBytes || 8 * 1024 * 1024;
        if (file.size > max) throw new Error('单份文件上限为 ' + formatSize(max) + '。');
        const partBytes = state.config.uploadPartBytes;
        if (partBytes && file.size > partBytes) material = await uploadInParts(file, request.sourceLabel, partBytes);
        else material = await post(casePath() + '/materials', { ...request, fileName: file.name, base64: await encodeFile(file) });
      }
      closeDialog();
      state.view = 'materials';
      await openCase(state.caseId, { materialId: material.id });
      if (state.contents.files.some((file) => file.id === material.id)) {
        openAttachment(material.id);
        return '附件原件已保存。';
      }
      return '材料原件已保存。';
    }
    case 'revision': {
      const version = activeVersion();
      const text = String(data.get('text'));
      if (version.text === text) throw new Error('请先修改文字再保存。');
      const saved = await post(materialPath() + '/revisions', {
        baseVersionId: version.id, baseTextSha256: version.textSha256, text, note: value('note') || undefined,
      });
      state.edits.delete(editKey(version.id));
      await openCase(state.caseId, { versionId: saved.id });
      return '修订已保存为新版本，原件与旧引用已保留。';
    }
    case 'run-intake': {
      if (!data.has('consent')) throw new Error('请先确认材料可以提交给 DeepSeek。');
      const sourceKinds = {};
      const selections = [];
      for (const [key, selection] of data) {
        if (key.startsWith('source:') && selection) sourceKinds[key.slice(7)] = selection;
        if (key.startsWith('version:') && selection) selections.push({ materialId: key.slice(8), versionId: selection });
      }
      closeDialog();
      const run = await post(casePath() + '/runs', {
        consent: true,
        goal: value('goal') || undefined,
        reuseRunId: value('reuse') || undefined,
        sourceKinds: Object.keys(sourceKinds).length ? sourceKinds : undefined,
        selections,
      });
      state.runId = run.id;
      state.view = 'draft';
      await openCase(state.caseId, { keepSelection: true });
      return '接案核对已保存。' + (runStates[run.status] || '');
    }
    case 'review-node': {
      const baselineRunId = value('baselineRunId');
      const currentRunId = value('currentRunId');
      if (baselineRunId === currentRunId && value('kind') !== 'hearing_preparation') throw new Error('请选择不同的两轮核对。');
      state.node = await post(casePath() + '/node-reviews', { baselineRunId, currentRunId, kind: value('kind') });
      closeDialog();
      render();
      return '已生成关键节点对照，可保存到导出底稿。';
    }
    case 'export': {
      const runId = value('runId');
      const request = { runId, previousOutputId: value('previousOutputId') || undefined };
      if (data.has('withNode')) {
        if (state.node.currentRunId !== runId) throw new Error('要包含节点对照，请选用该对照的当前核对轮次。');
        request.nodeReviewKind = state.node.kind;
        request.baselineRunId = state.node.baselineRunId;
      }
      await post(casePath() + '/outputs', request);
      await openCase(state.caseId, { keepSelection: true });
      openExport();
      return '底稿已保存。可下载 Word、Markdown 或 JSON。';
    }
    case 'checkpoint':
      await post(casePath() + '/checkpoints', { label: value('label') });
      await openCase(state.caseId, { keepSelection: true });
      await openHistory();
      return '案件保存点已创建。';
    case 'rollback':
      await post(casePath() + '/rollback', JSON.parse(form.dataset.preview));
      closeDialog();
      state.node = null;
      for (const key of state.edits.keys()) {
        if (key.startsWith(state.caseId + '/')) state.edits.delete(key);
      }
      await refreshCases();
      await openCase(state.caseId);
      return '整个案件已恢复到保存点。';
    default:
      throw new Error('无法识别该操作。');
  }
}

function openAttachment(id) {
  const item = state.contents.files.find((file) => file.id === id);
  if (!item) throw new Error('附件不在当前案件中。');
  showDialog(item.sourceLabel,
    el('p', '', item.fileName + ' · ' + formatSize(item.byteLength)),
    el('p', 'muted', '附件原件已保存。可下载查看，也可另行添加可核对文字。'),
    downloadLink(casePath() + '/files/' + segment(item.id) + '/original', '下载原件'),
  );
}

const actions = {
  'new-case': openCreateCase,
  'edit-case': openEditCase,
  'add-material': openAddMaterial,
  'close-dialog': closeDialog,
  'open-attachment': (control) => openAttachment(control.dataset.id),
  'case-history': () => task('读取案件版本…', async () => { await openHistory(); }),
  'run-intake': () => task('读取本轮可核对的材料…', async () => { await openRunIntake(); }),
  'review-node': openNodeReview,
  export: openExport,
  'open-output': (control) => task('读取已保存底稿…', async () => { await openSavedOutput(control.dataset.id); }),
  'show-draft': () => switchView('draft'),
  'open-case': (control) => task('打开案件…', async () => {
    const previous = state.caseId;
    try { await openCase(control.dataset.id); }
    catch (error) {
      state.caseId = '';
      if (previous && previous !== control.dataset.id) {
        await openCase(previous).catch(() => { state.caseId = ''; render(); });
      } else render();
      throw error;
    }
  }),
  'open-material': (control) => task('读取材料…', async () => {
    await openMaterial(control.dataset.id);
    state.view = 'materials';
    render();
  }),
  'clear-citation': () => { state.citation = null; render(); },
  'open-version': (control) => {
    state.versionId = control.dataset.id;
    state.citation = null;
    state.line = null;
    state.view = 'materials';
    closeDialog();
    render();
  },
  'pick-ocr-line': (control) => {
    const version = activeVersion();
    const ocr = versions().findLast((item) => item.kind === 'ocr');
    if (!version || !ocr) return;
    state.line = Number(control.dataset.index);
    render();
    const editor = dom.annotations.querySelector('textarea[name=text]');
    const line = ocr.lines[state.line].text.trim();
    const index = editor?.value.indexOf(line) ?? -1;
    editor?.focus();
    if (index >= 0) editor.setSelectionRange(index, index + line.length);
  },
  ocr: () => task('正在本地识别原件，首次运行可能需要加载语言模型…', async () => {
    const attempt = await api(materialPath() + '/ocr', { method: 'POST' });
    await openCase(state.caseId);
    if (attempt.status === 'failed') throw new Error('OCR 未取得文字：' + attempt.error.message);
    return 'OCR 识别已完成，请对照原件校对。';
  }),
  'preview-rollback': (control) => task('计算恢复差异…', async () => {
    openRollback(await api(casePath() + '/rollback/preview', { method: 'POST', data: { checkpointId: control.dataset.id } }));
  }),
};

function switchView(view) {
  state.view = view;
  render();
}

document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-action], [data-view]');
  if (!control || control.disabled) return;
  if (control.dataset.view) switchView(control.dataset.view);
  else actions[control.dataset.action]?.(control);
});

dom['workspace-tabs'].addEventListener('keydown', (event) => {
  const tabs = Array.from(dom['workspace-tabs'].querySelectorAll('[data-view]'));
  const index = tabs.indexOf(event.target);
  if (index < 0 || state.busy) return;
  const steps = { ArrowLeft: -1, ArrowRight: 1 };
  const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)
    : steps[event.key] ? tabs[(index + steps[event.key] + tabs.length) % tabs.length] : null;
  if (!next) return;
  event.preventDefault();
  next.focus();
  switchView(next.dataset.view);
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  if (state.busy) return;
  const error = form.querySelector('.dialog-error');
  if (error) error.hidden = true;
  const messages = { 'run-intake': '劳动法插件正在核对材料，完成后自动保存…', 'add-material': '保存材料原件…' };
  const data = new FormData(form);
  task(messages[form.dataset.form] || '处理中…', () => submitForm(form, data));
});

dom['workspace-dialog'].addEventListener('cancel', (event) => {
  if (state.busy) event.preventDefault();
});

render();
task('正在读取案件…', async () => {
  const [config, list] = await Promise.all([api('/api/config'), refreshCases()]);
  document.getElementById('public-demo-notice').hidden = !config.publicDemo;
  state.config = config;
  const preferred = readRememberedCase();
  const first = list.cases.find((record) => record.id === preferred) || list.cases[0];
  if (first) await openCase(first.id);
  else render();
  return list.unavailable?.length ? '有 ' + list.unavailable.length + ' 宗案件暂不可读取。' : '';
});
