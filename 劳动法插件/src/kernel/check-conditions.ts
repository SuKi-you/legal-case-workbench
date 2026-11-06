import { ELEMENT_STATES, type CheckSpec, type ElementSpec } from './contracts.ts';

const gapKinds = new Set(['conflicting', 'unread', 'absent', 'missing_document', 'evaluative', 'negative_fact', 'missing_period']);
const states = new Set<string>(ELEMENT_STATES);

/** Shared by knowledge validation and execution, so every accepted trigger has the same semantics. */
export function checkConditionProblems(check: CheckSpec, elements: readonly ElementSpec[]): string[] {
  const problems: string[] = [];
  const say = (message: string) => { problems.push(`校验 ${check.id} ${message}`); };
  const elementIds = new Set(elements.map(element => element.id));
  const needIds = new Set(elements.flatMap(element => element.needs));
  if (check.when.length === 0 && check.claim === undefined && check.gap === undefined) {
    say('没有触发条件，会无条件命中。');
  }
  for (const condition of check.when) {
    if (condition.elementId === undefined && condition.signal === undefined) say('含空条件。');
    if (condition.elementId !== undefined) {
      if (!elementIds.has(condition.elementId)) say(`引用了不存在的要件：${condition.elementId}`);
      if (condition.in === undefined || condition.in.length === 0) say(`含空状态集合（${condition.elementId}）。`);
      else if (condition.in.some(state => !states.has(state))) say(`含非法要件状态（${condition.elementId}）。`);
    } else if (condition.in !== undefined) say('的状态条件缺少要件引用。');
    if (condition.signal !== undefined && !condition.signal.trim()) say('含空的线索词。');
  }
  if (check.claim !== undefined && (!needIds.has(check.claim.needId)
    || check.claim.values.length === 0 || check.claim.values.some(value => !value.trim()))) {
    say('的结构化主张条件无效。');
  }
  if (check.gap !== undefined && (!elementIds.has(check.gap.elementId) || !gapKinds.has(check.gap.kind))) {
    say('的缺口条件无效。');
  }
  return problems;
}
