import type { NodePreparation, NodeReviewContributor, LoopSource } from './base.ts';

const notification = [
  'labor.need.term.by-employer', 'labor.need.term.by-employee', 'labor.need.term.by-agreement',
  'labor.need.term-form', 'labor.need.term-date', 'labor.need.term-lastday', 'labor.need.term-reason',
];
const wages = ['labor.need.wage-standard', 'labor.need.wage-payment', 'labor.need.wage-unpaid', 'labor.need.wage-base12'];
const contract = ['labor.need.double-signed', 'labor.need.double-period', 'labor.need.double-exclusion'];

/** Labor-specific review tasks use saved evidence and declared needs from this case. */
export const contributeLaborNodeReview: NodeReviewContributor = ({ kind, baseline, current, review }) => {
  const installed = new Set(current.needs.map(need => need.id));
  const items: NodePreparation[] = [];
  function add(id: string, needGroup: readonly string[], instruction: string, reason: string) {
    const needIds = needGroup.filter(needId => installed.has(needId));
    const relevant = new Set(needIds);
    const currentRecords = current.findings.filter(finding => relevant.has(finding.needId)).slice(0, 50);
    const baselineRecords = baseline.findings.filter(finding => relevant.has(finding.needId) && installed.has(finding.needId)).slice(0, 50);
    if (currentRecords.length + baselineRecords.length === 0) return;
    const sources = new Map<string, LoopSource>();
    for (const { citations } of currentRecords) {
      for (const { materialId, versionId, textSha256 } of citations)
        sources.set(`${materialId}/${versionId}/${textSha256}`, { materialId, versionId, textSha256 });
    }
    items.push({ id: `labor.node.${id}`, kind: 'prepare', instruction, reason, needIds,
      currentFindingIds: currentRecords.map(finding => finding.id),
      baselineFindingIds: baselineRecords.map(finding => finding.id),
      sources: [...sources.values()].slice(0, 100) });
  }
  if (kind === 'opponent_response') {
    add('response', notification, '并列双方关于通知人、方式、日期、原话的记载，调取原始通知和送达材料。',
      '区分针对同一次通知的否认和另一次安排，交承办人判断实际发生及法律意义。');
    add('response-payment', wages, '核对答辩所称的工资月份、应发口径、扣项、付款凭证及到账记录。',
      '金额差异须按同一工资期间和口径比较。');
  } else if (kind === 'new_evidence') {
    const changedNeeds = new Set(review.facts.map(change => change.needId));
    const changed = (group: readonly string[]) => group.some(needId => changedNeeds.has(needId));
    if (changed(notification)) add('notice-update', notification, '用新证据分别核对通知发出、送达、实际最后工作与明确生效时间。',
      '逐项更新所涉时间点及出处，保留仍有分歧或资料不足的部分。');
    if (changed(wages)) add('payment-update', wages, '将新增工资或转账证据放回对应月份，核对付款对象、实际到账和口径。',
      '标明新材料补上了哪一项及仍缺哪些月份、凭证或解释。');
    if (changed(contract)) add('contract-update', contract, '核对新增合同材料的签署时间、签署方、原件及所涉期间。',
      '以材料明确记载更新本轮准备事项。');
  } else {
    add('hearing-notice', notification, '准备通知、送达、排班与最后工作记录的原件及时间顺序，列出双方分歧。',
      '承办人根据原件核对提出方、事实和适用路径。');
    add('hearing-payment', wages, '准备逐月工资口径与实付凭证对照表，单列未核实的扣项和入账。',
      '金额测算使用承办人确认的适用口径和期间。');
    add('hearing-contract', contract, '准备书面合同、补签记录及用工起止材料，核对期间和双方陈述。',
      '把尚无原件或尚待核实的材料列入庭前补充清单。');
  }
  return items;
};
