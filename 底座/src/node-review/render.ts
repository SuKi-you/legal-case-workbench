import type { LoopSource } from '../loops/contracts.ts';
import type { NodeReview } from './contracts.ts';

type Evidence = NodeReview['facts'][number]['before'][number];
const nodeLabel = { opponent_response: '答辩审查', new_evidence: '新增证据审查', hearing_preparation: '庭前准备' } as const;
const sourceLabel = { added: '新选材料', version_changed: '选用版本变化', left_selection: '退出本次范围' } as const;
const factLabel = { new_record: '新匹配记录', evidence_changed: '出处变化', not_carried_forward: '基线记录本次未匹配' } as const;
const conflictLabel = { added: '当前新增差异', changed: '当前差异变化', not_carried_forward: '基线差异本次未匹配' } as const;
const coverageLabel = { found: '已找到记录', partial: '已有部分记录', unread: '未读', not_found_in_examined: '已检查范围内未见记载' } as const;
const supportLabel = { supported: '材料支持', opposed: '材料反向', unresolved: '待核对', conflicting: '相反记载', not_applicable: '不适用' } as const;
const actionLabel = { read: '补读', clarify: '澄清', human_review: '人工复核', prepare: '准备' } as const;
const classifyLabel = { inconsistent: '相反记载', possible_conflict: '可能相反', different_scope: '范围不同', insufficient_context: '上下文不足' } as const;
const sourceText = (source: LoopSource) => `材料 ${source.materialId}，版本 ${source.versionId}`;

function evidenceLines(label: string, records: readonly Evidence[]): string[] {
  return records.flatMap((item) => {
    const record = item.record;
    const factors = record ? [
      record.subject?.name, record.object?.name, record.period, record.basis,
      record.value.normalized ?? record.value.raw, record.value.unit, record.time.raw,
      { affirmed: '肯定记载', denied: '否定记载', uncertain: '不确定记载' }[record.polarity],
    ].filter(Boolean).join('／') : '';
    return [
      `${label}｜${item.statement}${factors ? `（${factors}）` : ''}`,
      ...item.citations.map((cite) => `出处｜${sourceText(cite)}，[ ${cite.start}, ${cite.end} )：「${cite.quote}」`),
    ];
  });
}

/** Shared plain text for terminal, Markdown, and Word rendering. */
export function nodeReviewLines(review: NodeReview): string[] {
  const lines = [
    `${nodeLabel[review.kind]}｜${review.status === 'ready_for_review' ? '可提交承办人复核' : '仍有待核事项'}`,
    `基线运行 ${review.baselineRunId}`,
    `当前运行 ${review.currentRunId}`,
  ];
  if (!review.scope.checked) lines.push('应审材料范围尚未核对。');
  for (const source of review.scope.missingSources) lines.push(`应审但本次未选｜${sourceText(source)}`);
  for (const source of review.scope.unexpectedSources) lines.push(`本次选用而应审清单不含｜${sourceText(source)}`);
  for (const materialId of review.scope.unreadMaterialIds ?? []) lines.push(`尚无文字版本｜材料 ${materialId}`);
  for (const fileId of review.scope.unparsedAttachmentIds ?? []) lines.push(`未解析附件｜${fileId}`);
  for (const change of review.sources) {
    lines.push(`材料｜${sourceLabel[change.kind]}${change.duplicateContent.length ? '，与其他选用版本文字相同' : ''}`);
    lines.push(...change.before.map((item) => `基线｜${sourceText(item)}`), ...change.after.map((item) => `当前｜${sourceText(item)}`));
    lines.push(...change.duplicateContent.map((item) => `同文来源｜${sourceText(item)}`));
  }
  for (const change of review.facts) {
    lines.push(`记录｜${factLabel[change.kind]}。${change.reason}`);
    lines.push(...evidenceLines('基线', change.before), ...evidenceLines('当前', change.after));
  }
  const coverageText = (item: NodeReview['coverage'][number]['before']) =>
    item ? `${coverageLabel[item.coverage]}（已检查 ${item.examined.length}，未读 ${item.unread.length}${item.missingFields.length ? `，缺字段 ${item.missingFields.join('、')}` : ''}）`
      : '无覆盖记录';
  for (const change of review.coverage) {
    lines.push(`覆盖｜${change.question} ${coverageText(change.before)} → ${coverageText(change.after)}${change.definitionChanged ? '。需求定义有变化。' : ''}`);
  }
  for (const change of review.conflicts) {
    lines.push(`差异｜${conflictLabel[change.kind]}`);
    for (const [label, item] of [['基线', change.before], ['当前', change.after]] as const) if (item) {
      lines.push(`${label}｜${classifyLabel[item.classification]}。${item.reason}`, ...evidenceLines(label, item.evidence));
    }
  }
  for (const change of review.professional.changes) {
    lines.push(`专业条件｜${change.checkId}，${change.before ? supportLabel[change.before.state] : '无记录'} → ${change.after ? supportLabel[change.after.state] : '无记录'}`);
    if (change.before) lines.push(`基线依据｜${change.before.reason}`, ...evidenceLines('基线', change.before.evidence));
    if (change.after) lines.push(`当前依据｜${change.after.reason}`, ...evidenceLines('当前', change.after.evidence));
  }
  lines.push('准备事项');
  for (const item of review.preparations) {
    lines.push(`${actionLabel[item.kind]}｜${item.instruction} ${item.reason}`);
    lines.push(...item.sources.map((source) => `所涉来源｜${sourceText(source)}`));
    if (item.currentFindingIds.length) lines.push(`当前记录｜${item.currentFindingIds.join('、')}`);
    if (item.baselineFindingIds.length) lines.push(`基线记录｜${item.baselineFindingIds.join('、')}`);
  }
  return lines;
}
