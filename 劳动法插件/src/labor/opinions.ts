/**
 * 劳动法知识包 · 评价性要件的提问模板
 *
 * 只有这些要件会走模型评估（一次调用、给倾向与理由）。
 * 模板本身是数据：改提问不需要改代码，也不影响任何纯函数判定。
 */
import type { OpinionSpec } from '../kernel/contracts.ts';

export const LABOR_OPINIONS: readonly OpinionSpec[] = Object.freeze([
  {
    elementId: 'labor.evaluative.misconduct',
    question: '根据现有材料，单位主张的「严重违反规章制度」在多大程度上站得住？',
    factors: [
      '规章制度内容是否合法',
      '是否经民主程序制定',
      '是否已公示或告知劳动者',
      '违纪事实是否有证据支持',
      '处分与违纪程度是否相当',
      '同类行为此前是否有不同处理',
    ],
    guidance: '制度程序有瑕疵、或处分明显不成比例时，倾向应偏 unlikely 或 unclear；不得仅因「单位主张了」就倾向 likely。',
  },
  {
    elementId: 'labor.evaluative.agreement-fairness',
    question: '解除协议约定的补偿与依法应得相比，是否达到「显失公平」的程度？',
    factors: [
      '协议约定的补偿金额',
      '按法定标准应得的补偿金额',
      '双方的信息与谈判地位',
      '签署过程是否存在催促、误导或趁人之危',
    ],
    guidance: '差距不大、或劳动者已知情并自愿签署的，倾向应偏 unlikely；不得仅凭金额差距就认定显失公平。',
  },
]);
