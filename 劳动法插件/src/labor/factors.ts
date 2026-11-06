/**
 * 劳动法知识包 · 事实因子
 *
 * 因子不是结论，是"材料完整度"的加权提示：
 * - satisfied 计满权重，statement_only 计一半，absent/unread 计 0；
 * - 得分 = 实得 / 总权重，再落档；
 * - 输出只给"较强/中等/较弱"，不产出概率，也不替代从属性的实质判断。
 */
import type { FactorSpec } from '../kernel/contracts.ts';

export const LABOR_FACTORS: readonly FactorSpec[] = Object.freeze([
  {
    id: 'labor.factor.subordination',
    title: '从属性材料完整度',
    issueId: 'labor.relationship',
    parts: [
      { elementId: 'labor.relationship.subordination', weight: 3 },
      { elementId: 'labor.relationship.work', weight: 2 },
      { elementId: 'labor.relationship.business', weight: 2 },
      { elementId: 'labor.relationship.pay', weight: 1 },
      { elementId: 'labor.relation.form', weight: 1 },
    ],
    bands: [
      { min: 0.75, label: '较强', note: '从属性相关事实较完整，可据此主张劳动关系；仍须预判劳务关系抗辩。' },
      { min: 0.45, label: '中等', note: '部分从属性事实成立，建议优先补强劳动管理与业务组成的记载。' },
      { min: 0, label: '较弱', note: '从属性材料不足，对方主张劳务或合作关系的风险较高，应先补证。' },
    ],
    note: '本分只反映材料完整度，不构成劳动关系认定；认定仍以从属性三要素的实质判断为准。',
  },
]);
