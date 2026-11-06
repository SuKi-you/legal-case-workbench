/**
 * 通用结构层 · 成果区块
 *
 * 底座 OutputSection 的硬约束：每个段落、每个表格行都必须引用至少一条本运行内的 finding。
 * 因此这里只渲染"有出处"的内容；"完全没有材料"的缺口交给工具输出，不写进区块。
 */
import {
  MATERIAL_KIND_LABEL,
  type Assessment, type DomainKnowledge, type ElementState, type FindingView,
  type IssueState, type PathAssessment, type RunView,
} from './contracts.ts';

export interface SectionParagraph { text: string; findingIds: string[] }
export interface SectionTableRow { cells: string[]; findingIds: string[] }
export interface SectionTable { title: string; columns: string[]; rows: SectionTableRow[] }
export interface SectionView {
  id: string;
  title: string;
  provider: { id: string; version: string };
  paragraphs: SectionParagraph[];
  tables: SectionTable[];
}

const ISSUE_LABEL: Readonly<Record<IssueState, string>> = Object.freeze({
  judgeable: '要件基本齐备，可判断',
  disputed: '存在矛盾记载，需人工核对',
  insufficient: '材料不足，暂不能判断',
  not_applicable: '专业上不适用',
});

const ELEMENT_LABEL: Readonly<Record<ElementState, string>> = Object.freeze({
  satisfied: '有书证/已核对',
  statement_only: '仅有陈述',
  absent: '无对应记载',
  unread: '尚未读取',
  conflicting: '记载矛盾',
  not_applicable: '不适用',
  opposed: '有反向记载',
  needs_review: '仍待核对',
});

const BURDEN_LABEL: Readonly<Record<string, string>> = Object.freeze({
  claimant: '主张方',
  respondent: '对方',
  shared: '双方',
  authority: '主管机关',
});

const MAX_ROWS = 200;
const MAX_CELL = 2000;

function clip(text: string, max = MAX_CELL): string {
  const value = text.replace(/\s+/gu, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/** finding 的期间或日期表达，用于按期归集。 */
function periodOf(finding: FindingView): string {
  const period = finding.record?.period?.trim();
  if (period) return period;
  const start = finding.record?.time?.start?.trim();
  if (start) return start;
  const raw = finding.record?.time?.raw?.trim();
  return raw || '未载明期间';
}

function amountOf(finding: FindingView): string {
  const value = finding.record?.value;
  if (!value) return '';
  const normalized = value.normalized?.trim();
  if (normalized) return value.unit ? `${normalized}${value.unit}` : normalized;
  return value.raw?.trim() ?? '';
}

/** 争点状态总览：只列"已有出处的争点"。 */
function overviewSection(knowledge: DomainKnowledge, assessment: Assessment): SectionView | null {
  const paragraphs: SectionParagraph[] = [];
  for (const issue of assessment.issues) {
    if (issue.findingIds.length === 0) continue;
    const elementLines = issue.elementIds.map((id) => {
      const element = assessment.elements.find((item) => item.elementId === id);
      return element ? `${element.title}=${ELEMENT_LABEL[element.state]}` : null;
    }).filter((line): line is string => line !== null);
    paragraphs.push({
      text: clip(`${issue.title}：${ISSUE_LABEL[issue.state]}。判定理由：${issue.reason}要件现状：${elementLines.join('；')}。`),
      findingIds: unique(issue.findingIds),
    });
  }
  if (paragraphs.length === 0) return null;
  return {
    id: 'domain.issue-overview',
    title: '争点状态总览',
    provider: { id: knowledge.id, version: knowledge.version },
    paragraphs,
    tables: [],
  };
}

/** 要件事实矩阵：只列"有出处"的要件行。 */
function elementSection(knowledge: DomainKnowledge, assessment: Assessment): SectionView | null {
  const rows: SectionTableRow[] = [];
  for (const element of assessment.elements) {
    if (element.findingIds.length === 0) continue;
    const missing = element.missingFields.length > 0 ? `缺字段：${element.missingFields.join('、')}` : '';
    const note = element.state === 'satisfied' ? '已达本要件要求'
      : missing || (element.kind === 'evaluative' ? '评价性要件，需综合判断' : '见缺口清单');
    rows.push({
      cells: [
        clip(element.title), ELEMENT_LABEL[element.state], BURDEN_LABEL[element.burden] ?? element.burden,
        String(element.findingIds.length), clip(note),
      ],
      findingIds: unique(element.findingIds),
    });
    if (rows.length >= MAX_ROWS) break;
  }
  if (rows.length === 0) return null;
  return {
    id: 'domain.element-matrix',
    title: '要件事实矩阵',
    provider: { id: knowledge.id, version: knowledge.version },
    paragraphs: [],
    tables: [{
      title: `要件与证据（共 ${assessment.elements.length} 项要件，此处仅列已有出处的 ${rows.length} 项）`,
      columns: ['要件', '状态', '举证责任', '证据条数', '说明'],
      rows,
    }],
  };
}

const PATH_LABEL: Readonly<Record<string, string>> = Object.freeze({
  available: '要件齐备', needs_check: '需核实', insufficient: '缺要件', blocked: '被抗辩阻断',
});

/**
 * 路径对比：同一争点存在多条路径时并列展示，不排序、不推荐。
 * 与缺口一样，没有出处的路径无法进入区块，只在这里提示"另有几条"。
 */
function pathsSection(knowledge: DomainKnowledge, assessment: Assessment): SectionView | null {
  const byIssue = new Map<string, PathAssessment[]>();
  for (const path of assessment.paths) {
    const list = byIssue.get(path.issueId);
    if (list) list.push(path); else byIssue.set(path.issueId, [path]);
  }
  const multi = [...byIssue.entries()].filter(([, paths]) => paths.length > 1);
  if (multi.length === 0) return null;

  const rows: SectionTableRow[] = [];
  const anchors: string[] = [];
  let hidden = 0;
  for (const [issueId, paths] of multi) {
    const issue = assessment.issues.find((item) => item.issueId === issueId);
    for (const path of paths) {
      if (path.findingIds.length === 0) { hidden += 1; continue; }
      anchors.push(...path.findingIds);
      rows.push({
        cells: [
          clip(path.name),
          PATH_LABEL[path.state] ?? path.state,
          clip(path.outcome),
          clip(issue ? `${issue.title}` : issueId),
          clip(path.missing.length === 0 ? '—' : path.missing.length + ' 项待补'),
        ],
        findingIds: unique(path.findingIds),
      });
      if (rows.length >= MAX_ROWS) break;
    }
  }
  if (rows.length === 0) return null;

  const paragraphs: SectionParagraph[] = [];
  if (hidden > 0) {
    paragraphs.push({
      text: clip(`另有 ${hidden} 条路径完全没有对应材料，无法在本区块引用出处，请在“路径清单”中查看。`),
      findingIds: unique(anchors),
    });
  }
  paragraphs.push({
    text: clip('以上路径并列陈列，金额与举证要求各不相同。选哪一条由承办人根据事实核实结果决定，本底稿不作推荐。'),
    findingIds: unique(anchors),
  });

  return {
    id: 'domain.paths',
    title: '可能的法律路径',
    provider: { id: knowledge.id, version: knowledge.version },
    paragraphs,
    tables: [{
      title: '路径对比（并列，不排序）',
      columns: ['路径', '状态', '法律结果', '所属争点', '缺口'],
      rows,
    }],
  };
}

/** 按期归集：把带期间或金额的记载排成台账，缺口月份由工具另行提示。 */function ledgerSection(knowledge: DomainKnowledge, run: RunView): SectionView | null {
  // 只归集属于本知识包需求的记载：用通用 profile 跑出的运行不应被本法域"收编"。
  const ownNeeds = new Set(knowledge.elements.flatMap((element) => element.needs));
  const findings = run.findings.filter((finding) => {
    if (!ownNeeds.has(finding.needId)) return false;
    const period = finding.record?.period?.trim();
    const start = finding.record?.time?.start?.trim();
    return Boolean(period || start || finding.record?.value);
  });
  if (findings.length === 0) return null;

  const grouped = new Map<string, FindingView[]>();
  for (const finding of findings) {
    const key = periodOf(finding);
    const list = grouped.get(key);
    if (list) list.push(finding); else grouped.set(key, [finding]);
  }
  const rows: SectionTableRow[] = [...grouped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .slice(0, MAX_ROWS)
    .map(([period, items]) => ({
      cells: [
        clip(period),
        clip(items.map((item) => item.record?.event?.key ?? item.statement).join('；')),
        clip(unique(items.map(amountOf).filter((value) => value.length > 0)).join('、') || '—'),
        String(items.length),
      ],
      findingIds: unique(items.map((item) => item.id)),
    }));

  return {
    id: 'domain.ledger',
    title: '按期归集与金额',
    provider: { id: knowledge.id, version: knowledge.version },
    paragraphs: [],
    tables: [{
      title: `按期间/日期归集的记载（共 ${rows.length} 组）`,
      columns: ['期间/日期', '事项', '金额', '记载条数'],
      rows,
    }],
  };
}

/**
 * 缺口说明：只写"已有部分出处"的缺口。
 * 完全没有材料的缺口不能写进区块（无 finding 可引），由工具输出。
 */
function gapSection(knowledge: DomainKnowledge, assessment: Assessment): SectionView | null {
  const gaps = assessment.gaps.filter((gap) => gap.findingIds.length > 0);
  if (gaps.length === 0) return null;
  const paragraphs: SectionParagraph[] = gaps.slice(0, MAX_ROWS).map((gap) => {
    const element = assessment.elements.find((item) => item.elementId === gap.elementId);
    const material = element ? element.missingMaterials.map((kind) => MATERIAL_KIND_LABEL[kind]).join('、') : '';
    return {
      text: clip(`【${element?.title ?? gap.elementId}】${gap.consequence}建议动作：${gap.action}${material ? `（可补：${material}）` : ''}`),
      findingIds: unique(gap.findingIds),
    };
  });
  const hidden = assessment.gaps.length - gaps.length;
  if (hidden > 0) {
    const anchor = unique(gaps.flatMap((gap) => gap.findingIds));
    paragraphs.push({
      text: clip(`另有 ${hidden} 项要件完全没有对应材料，无法在本区块引用出处，请在“缺口清单”中查看。`),
      findingIds: anchor,
    });
  }
  return {
    id: 'domain.gaps',
    title: '缺口与举证方向',
    provider: { id: knowledge.id, version: knowledge.version },
    paragraphs,
    tables: [],
  };
}

/**
 * 生成全部可用区块。顺序稳定，便于底稿版本比对。
 * 返回空数组表示本次运行没有可渲染的专业内容。
 */
export function renderSections(knowledge: DomainKnowledge, assessment: Assessment, run: RunView): SectionView[] {
  return [
    overviewSection(knowledge, assessment),
    elementSection(knowledge, assessment),
    pathsSection(knowledge, assessment),
    ledgerSection(knowledge, run),
    gapSection(knowledge, assessment),
  ].filter((section): section is SectionView => section !== null);
}

export { ELEMENT_LABEL, ISSUE_LABEL };
