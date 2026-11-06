import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableCell, TableRow,
  WidthType, BorderStyle, type FileChild,
} from 'docx';
import type { OutputDraft } from './contracts.ts';
import { nodeReviewLines } from '../node-review/index.ts';

export type OutputBlock = { kind: 'title' | 'heading' | 'paragraph'; text: string; compact?: boolean; keepNext?: boolean }
  | { kind: 'table'; columns: string[]; rows: string[][] };
const labels: Record<string, string> = {
  active: '在办', paused: '暂停', closed: '结案',
  completed: '本次需求已完成', needs_review: '待核对', stalled: '无新动作，已停止', limit_reached: '预算耗尽，已停止',
  inconsistent: '可比记载不一致', possible_conflict: '疑似冲突', different_scope: '比较范围不同', insufficient_context: '比较条件不足',
  found: '已找到', partial: '部分已有', not_found_in_examined: '已查范围未找到', unread: '尚有未读',
  consistent: '未列不一致', ambiguous: '含义或条件待核对', conflicting: '存在不一致',
  statement_only: '已有陈述', document_supported: '已有文件记载', inference_only: '仅有推断', none: '尚无记录',
  satisfied: '满足本次声明条件', needs_information: '待补充必要信息', not_applicable: '本次不适用',
  same_entity: '主体对应', possible_same_entity: '主体对应候选', same_event: '同一事件', possible_same_event: '同一事件候选',
  equivalent_claim: '等价表达', same_source_content: '相同来源文字', confirmed: '记录关系已确认', suggested: '待核对候选',
  time_not_resolved: '时间尚未明确', value_not_resolved: '数值尚未明确', period_not_resolved: '所属期间尚未明确',
  period_year_or_range_not_resolved: '期间年份或范围尚未明确', approximate_or_ranged_value: '数值为近似值或范围',
  inference_requires_review: '推断内容有待复核', boolean_not_resolved: '肯否含义有待复核',
  subject: '主体', object: '对象', attributedTo: '陈述归属', 'event.key': '事件标识', time: '明确时间', value: '具体内容或数值',
  period: '所属期间', basis: '比较口径', document_support: '对应事项的支持材料', structured_record: '可核对的结构化记录',
  information: '对应信息', spec: '专业需求匹配条件', CNY: '人民币', USD: '美元', HKD: '港元',
};
const label = (value: string) => labels[value] ?? value;
const localTimestamp = (value: string): string => {
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? value : `${new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(instant)}（北京时间）`;
};

/** One content tree keeps the Markdown and Word versions substantively aligned. */
export function outputBlocks(draft: OutputDraft): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  const p = (text: string, formatting: { compact?: boolean; keepNext?: boolean } = {}) => blocks.push({ kind: 'paragraph', text, ...formatting });
  const h = (text: string) => blocks.push({ kind: 'heading', text });
  const refs = (id: string) => draft.references.filter((reference) => reference.findingId === id).map((reference) => `[${reference.id}]`).join(' ');
  const finding = (id: string) => draft.findings.find((item) => item.id === id)!;
  const cited = (id: string) => `${finding(id).statement} ${refs(id)}`;
  blocks.push({ kind: 'title', text: `${draft.case.title} ${draft.nodeReview ? '关键节点审查底稿' : '接案材料整理底稿'}` });
  p(`本底稿围绕“${draft.goal}”整理材料中的记载与陈述，保留出处、不同说法及未明确事项，供承办人核对。`);
  p(`本次处理：${label(draft.runStatus)}。${draft.runReason}`);
  if (draft.nodeReview) {
    h('关键节点变化与准备清单');
    for (const line of nodeReviewLines(draft.nodeReview)) p(line);
  }
  const excluded = draft.materials.filter((material) => material.includedVersions.length === 0).length;
  const activeCoverage = draft.analysis?.needs.filter((need) => need.satisfaction !== 'not_applicable');
  const examinedPairs = activeCoverage?.reduce((sum, need) => sum + need.examined.length, 0);
  const unreadPairs = activeCoverage?.reduce((sum, need) => sum + need.unread.length, 0);
  p(`整理范围：选定 ${draft.sources.length} 个文字版本；${excluded} 份登记材料未纳入；${draft.attachments.length} 个原始附件尚未作为可读文字解析。`);
  if (activeCoverage) p(`逐需求读取台账：已处理 ${examinedPairs} 个“需求×版本”组合，尚有 ${unreadPairs} 个组合未处理。${unreadPairs! > 0 ? '本稿为部分核对成果，未读范围不能作为缺证或事实不存在的依据。' : '选定范围已按本轮需求处理；这不代表记载真实、证据充分或法律条件成立。'}`);
  else p('本次未提供逐需求读取台账，覆盖程度未知，不能据此宣称全量核对完成。');
  if (draft.readIssues?.length) {
    h('读取复核未通过的范围');
    for (const issue of draft.readIssues) {
      const material = draft.materials.find(item => item.materialId === issue.source.materialId);
      const need = draft.needs.find(item => item.id === issue.needId);
      p(`${material?.label ?? issue.source.materialId}｜${need?.question ?? issue.needId}｜版本 ${issue.source.versionId}｜仍待核（${issue.code}）。`);
    }
  }
  h('一 案件概况与底稿版本');
  p(`案件名称：${draft.case.title}；内部案号：${draft.case.caseNumber ?? '未填写'}；办理阶段：${draft.case.stage}；人工状态：${label(draft.case.status)}。`);
  if (draft.case.description) p(`案件说明：${draft.case.description}`);
  p(`生成时间：${localTimestamp(draft.createdAt)}；模板：${draft.templateVersion}`);
  p(`案件 ID：${draft.caseId}`); p(`底稿 ID：${draft.outputId}`); p(`来源运行 ID：${draft.runId}`);
  p('下列内容固定于本次选定版本。后续补料或修订后，应生成并对照新版底稿。');
  h('二 材料与附件索引');
  if (draft.materials.length === 0) p('本案尚无登记材料。');
  blocks.push({ kind: 'table', columns: ['编号', '材料名称', '本次整理范围'], rows: draft.materials.map((material, index) => [
    `M${index + 1}`, material.label, material.includedVersions.length > 0 ? `已选 ${material.includedVersions.length} 个文字版本` : '未纳入本次整理',
  ]) });
  for (const [index, material] of draft.materials.entries()) {
    p(`M${index + 1} 材料 ID：${material.materialId}；类型：${material.kind === 'image' ? '图片' : '文字'}。`);
    for (const version of material.includedVersions) p(`选定文字版本：${version.versionId}；文字 SHA-256：${version.textSha256}`);
    if (material.availableVersionIds.length > material.includedVersions.length) p(`案内共有 ${material.availableVersionIds.length} 个可选文字版本；其余版本未自动作为本次输入。`);
  }
  if (draft.attachments.length > 0) {
    p('以下为原始附件登记，未因登记而自动解析或纳入本次文字核对。');
    for (const attachment of draft.attachments) p(`${attachment.label}；文件名：${attachment.fileName}；附件 ID：${attachment.fileId}`);
  }
  h('三 人物与跨材料关联');
  if (draft.analysis) {
    for (const entity of draft.analysis.entities) p(`${entity.names.join('、')}（${entity.kind === 'person' ? '个人' : entity.kind === 'organization' ? '机构' : '类型未明'}） ${entity.findingIds.map(refs).join(' ')}`);
    for (const relation of draft.analysis.relations) {
      p(`${label(relation.kind)}，${label(relation.status)}：${relation.reason} ${relation.findingIds.map(refs).join(' ')}`);
    }
    if (draft.analysis.entities.length === 0) p('本次未提取到可列示的主体归组。');
  } else p('本次运行没有结构化主体与关联分析，以下原文记录继续保留。');
  h('四 时间线与日期未明事项');
  if (draft.timeline.length === 0) p('本次尚无可按明确年月或日期排列的记录。');
  for (const event of draft.timeline) p(`${event.start === event.end ? event.start : `${event.start} 至 ${event.end}`}（${event.precision === 'month' ? '仅明确到月份' : event.precision === 'range' ? '日期范围' : '明确日期'}）：${cited(event.findingId)}`);
  if (draft.uncertainTimeFindingIds.length > 0) {
    p('日期未明或只有相对时间的记录单列，不推算具体日期，也不据此强排先后。');
    for (const id of draft.uncertainTimeFindingIds) p(`${finding(id).record?.time.raw ?? '时间未明确'}：${cited(id)}`);
  }
  h('五 带出处的材料记载与陈述');
  if (draft.findings.length === 0) p('本次选定且已读取范围未返回相关记录；不等于案件不存在这些信息。');
  for (const item of draft.findings) {
    const origin = item.record?.origin === 'document_record' ? '文件记载' : item.record?.origin === 'inference' ? '推断，待核对' : '陈述记录';
    p(`${origin}：${cited(item.id)}`);
    if (item.record) {
      const record = item.record;
      p(`陈述归属：${record.attributedTo?.name ?? '原文未明确'}；动作主体：${record.subject?.name ?? '未明确'}；对象：${record.object?.name ?? '未明确'}。`);
      if (record.value.normalized !== null) p(`结构化内容：${record.value.normalized}${record.value.unit ? ` ${record.value.unit}${labels[record.value.unit] ? `（${label(record.value.unit)}）` : ''}` : ''}；期间：${record.period ?? '未明确'}；口径：${record.basis ?? '未明确'}。`);
      if (record.uncertainty.length > 0) p(`保留的未知项：${record.uncertainty.map(label).join('；')}`);
    }
  }
  h('六 不一致与待核对的差异');
  if (!draft.analysis) p('本次尚无结构化差异核对结果。');
  else if (draft.analysis.conflicts.length === 0) p('本次结构化比较未列出冲突项，仍需结合读取范围和缺项核对。');
  else for (const conflict of draft.analysis.conflicts) {
    p(`${label(conflict.classification)}：${conflict.reason}`);
    for (const id of conflict.findingIds) p(cited(id));
  }
  h('七 专业需求覆盖与后续事项');
  if (!draft.analysis) p('本次尚无结构化需求覆盖结果。');
  else for (const need of draft.analysis.needs) {
    p(`${draft.needs.find((item) => item.id === need.needId)?.question ?? need.needId}：${label(need.satisfaction)}。`);
    p(`内容：${label(need.coverage)}；一致性：${label(need.consistency)}；支持类型：${label(need.support)}；本需求已读 ${need.examined.length} 个版本，未读 ${need.unread.length} 个版本。`);
    p(need.reason);
    if (need.missingFields.length > 0) p(`待补字段：${need.missingFields.map(label).join('、')}`);
    for (const action of need.nextActions) p(`后续事项：${action.instruction} 理由：${action.reason}`);
    if (need.findingIds.length > 0) p(`已有记录出处：${need.findingIds.map(refs).join(' ')}`);
  }
  for (const section of draft.sections) {
    h(`专业插件贡献 ${section.title}`);
    p(`提供方：${section.provider.id}；版本：${section.provider.version}。以下为该插件提供、引用案内记录的专业贡献，需承办人复核；底座不将其自动认定为已证实事实。`);
    for (const paragraph of section.paragraphs) p(`${paragraph.text} ${paragraph.findingIds.map(refs).join(' ')}`);
    for (const table of section.tables) {
      p(table.title); blocks.push({ kind: 'table', columns: [...table.columns, '出处'],
        rows: table.rows.map((row) => [...row.cells, row.findingIds.map(refs).join(' ')]) });
    }
  }
  if (draft.professionalReview) {
    h('专业复核与待办');
    const review = draft.professionalReview;
    const states: Record<string, string> = { supported: '现有记录提供支持', opposed: '存在反向记载', unresolved: '尚待核实', conflicting: '记录有冲突', not_applicable: '本轮不适用' };
    const decisions: Record<string, string> = { ready: '本轮专业检查完成', continue: '需要进一步读取', needs_input: '需要补充信息', human_review: '需要人工专业核对' };
    p(`专业复核器：${review.reviewer.id}；规则版本：${review.reviewer.version}；结果：${decisions[review.decision] ?? review.decision}。以下状态描述材料支持与核对进度，不构成事实认定。`);
    for (const item of review.assessments) p(`${item.checkId}：${states[item.state] ?? item.state}。${item.reason} ${item.findingIds.map(refs).join(' ')}`);
    for (const action of review.actions) p(`待办：${action.instruction} 理由：${action.reason}；对应信息需求：${action.needId}。`);
  }
  if (draft.changes) {
    h('八 与上一版底稿的记录变化');
    p(`上一版底稿 ID：${draft.changes.previousOutputId}。此处描述记录集合变化，不将未再列出的差异自动认定为事实已解决。`);
    for (const statement of draft.changes.addedStatements) p(`本版新增记录：${statement}`);
    for (const statement of draft.changes.removedStatements) p(`本版未再列入的记录：${statement}`);
    for (const reason of draft.changes.addedConflicts) p(`本版新增差异项：${reason}`);
    for (const reason of draft.changes.removedConflicts) p(`本版未再列入的差异项：${reason}`);
    for (const change of draft.changes.needChanges) p(`需求 ${change.needId}：${change.before ?? '此前未列'} → ${change.after ?? '本版未列'}`);
    if (draft.changes.addedStatements.length + draft.changes.removedStatements.length + draft.changes.addedConflicts.length + draft.changes.removedConflicts.length + draft.changes.needChanges.length === 0) p('本次对照未发现上述记录集合变化。');
  }
  h('来源摘录与固定版本定位');
  for (const reference of draft.references) {
    const citation = reference.citation;
    p(`[${reference.id}] 材料：${draft.materials.find((material) => material.materialId === citation.materialId)?.label ?? citation.materialId}`, { compact: true, keepNext: true });
    p(`材料 ID：${citation.materialId}；文字版本：${citation.versionId}`, { compact: true, keepNext: true });
    p(`文字 SHA-256：${citation.textSha256}；UTF-16 位置：[${citation.start}, ${citation.end})`, { compact: true, keepNext: true });
    p(`原文摘录：${citation.quote}`, { compact: true, keepNext: false });
  }
  return blocks;
}

const escapeMarkdown = (text: string) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/([\\`*_{}\[\]#|])/gu, '\\$1').replace(/\r?\n/gu, '  \n');
export function renderOutputMarkdown(draft: OutputDraft): string {
  return `${outputBlocks(draft).map((block) => {
    if (block.kind === 'table') {
      if (block.rows.length === 0) return '';
      return [`| ${block.columns.map(escapeMarkdown).join(' | ')} |`, `| ${block.columns.map(() => '---').join(' | ')} |`,
        ...block.rows.map((row) => `| ${row.map((cell) => escapeMarkdown(cell).replace(/\r?\n/gu, '<br>')).join(' | ')} |`)].join('\n');
    }
    return `${block.kind === 'title' ? '# ' : block.kind === 'heading' ? '## ' : ''}${escapeMarkdown(block.text)}`;
  }).filter(Boolean).join('\n\n')}\n`;
}

export async function renderOutputDocx(draft: OutputDraft): Promise<Buffer> {
  const content: FileChild[] = [];
  const run = (text: string, bold = false, compact = false) => new TextRun({ text, bold, ...(compact ? { size: 18 } : {}), font: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '宋体' }, color: '000000' });
  for (const block of outputBlocks(draft)) {
    if (block.kind === 'table') {
      if (block.rows.length === 0) continue;
      // Wide plugin tables become readable vertical records instead of tiny columns.
      if (block.columns.length > 4) {
        for (const [index, row] of block.rows.entries()) {
          content.push(new Paragraph({ children: [run(`记录 ${index + 1}`, true)], spacing: { before: 100, after: 80 }, keepNext: true }));
          for (const [column, value] of row.entries()) content.push(new Paragraph({ children: [run(`${block.columns[column]}：${value}`)], spacing: { after: 100 } }));
        }
      } else {
        content.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE },
          borders: { top: { style: BorderStyle.SINGLE, size: 4, color: 'D0D0D0' }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D0D0D0' },
            left: { style: BorderStyle.SINGLE, size: 4, color: 'D0D0D0' }, right: { style: BorderStyle.SINGLE, size: 4, color: 'D0D0D0' },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'D0D0D0' }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'D0D0D0' } },
          rows: [block.columns, ...block.rows].map((row, index) => new TableRow({ tableHeader: index === 0,
            children: row.map((cell) => new TableCell({ margins: { top: 100, bottom: 100, left: 100, right: 100 },
              ...(index === 0 ? { shading: { fill: 'F2F2F2' } } : {}),
              children: [new Paragraph({ children: [run(cell, index === 0)], spacing: { after: 50, line: 300 } })] })),
          })) }));
        content.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      }
    } else content.push(new Paragraph({
      ...(block.kind === 'title' ? { heading: HeadingLevel.TITLE } : block.kind === 'heading' ? { heading: HeadingLevel.HEADING_1 } : {}),
      children: [run(block.text, block.kind !== 'paragraph', block.compact)],
      spacing: { before: block.kind === 'heading' ? 240 : 0, after: block.kind === 'title' ? 240 : block.compact ? 60 : 120, line: block.compact ? 250 : 330 },
      keepNext: block.keepNext ?? block.kind !== 'paragraph',
    }));
  }
  return Packer.toBuffer(new Document({ creator: '法律 Agent', title: `${draft.case.title} 接案材料整理底稿`,
    styles: { default: { document: { run: { font: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '宋体' }, size: 22, color: '000000' } },
      title: { run: { size: 36, color: '000000' } }, heading1: { run: { size: 28, color: '000000' } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children: content }],
  }));
}
