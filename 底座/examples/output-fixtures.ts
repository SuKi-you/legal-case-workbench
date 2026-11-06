import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { organizeCaseInformation } from '../src/information/service.ts';
import type { JsonModel } from '../src/information/model.ts';
import type { InformationRecord, StructuredNeed } from '../src/information/contracts.ts';

export const outputFixtureTexts = [
  '甲（工号E001）于2026年9月10日记录流水T1实付6000元。',
  '甲（工号E001）于2026年9月10日记载流水T1实付8000元。',
  '甲（工号E001）称：上周乙告诉我“不要再来了”。具体日期说不清。',
] as const;
const needs: StructuredNeed[] = [{ id: 'example.payment', question: '流水T1实付多少？', reason: '核对同笔交易的金额记载',
  spec: { topic: 'example.payment', subject: '甲', object: null, period: '2026-09', basis: '实付',
    requiredFields: ['subject', 'event.key', 'time', 'value', 'period', 'basis'], minimumSupport: 'statement', applicable: true } },
{ id: 'example.communication', question: '乙对甲说了什么？', reason: '保留陈述及相对时间，不推断法律意义',
  spec: { topic: 'example.communication', subject: null, object: null, period: null, basis: null,
    requiredFields: ['value'], minimumSupport: 'statement', applicable: true } }];

/** Deterministic fixture parser, not a language model and not a production reader. */
export function createOutputFixtureModel(): JsonModel {
  return { id: 'output-fixture-only', model: 'deterministic-no-network', async complete({ system, user }) {
    const payload = JSON.parse(user);
    if (system.includes('INFORMATION_SEMANTIC_REVIEW')) return { verdicts: payload.items.map((_: unknown, index: number) => ({ index,
      relevant: true, supported: true, rolesCorrect: true, polarityCorrect: true, reason: '仅验证导出机制的固定夹具' })) };
    const text: string = payload.segment.text, topic: string = payload.needs[0].spec.topic;
    const person = { name: '甲', kind: 'person' as const, identity: { scheme: 'employee_id', value: 'E001' } };
    let record: InformationRecord;
    if (topic === 'example.payment' && /实付\d+元/u.test(text)) record = {
      topic, subject: person, object: null, attributedTo: person,
      event: { type: topic, key: 'T1', description: '流水T1实付金额记载' },
      time: { raw: '2026年9月10日', start: null, end: null, precision: 'unknown' },
      value: { kind: 'money', raw: /实付(\d+元)/u.exec(text)![1]!, normalized: null, unit: null },
      polarity: 'affirmed', period: '2026-09', basis: '实付', origin: 'party_statement', qualifiers: {}, uncertainty: [],
    };
    else if (topic === 'example.communication' && text.includes('不要再来了')) record = {
      topic, subject: { name: '乙', kind: 'person', identity: null }, object: person, attributedTo: person,
      event: { type: topic, key: null, description: '乙向甲讲话' }, time: { raw: '上周', start: null, end: null, precision: 'relative' },
      value: { kind: 'text', raw: '不要再来了', normalized: null, unit: null }, polarity: 'affirmed', period: null, basis: null,
      origin: 'party_statement', qualifiers: {}, uncertainty: [],
    };
    else return { items: [] };
    return { items: [{ statement: text, record, quotes: [{ segmentId: payload.segment.id, quote: text, occurrence: null }] }] };
  } };
}

export async function createOutputFixture(dataDir: string) {
  const cases = new CaseStore(dataDir), workspace = new CaseWorkspace(dataDir, cases);
  const record = await cases.create({ title: '甲与乙材料核对示例', actor: '虚构导出验收', description: '两份金额记载与一份口头讲话陈述' });
  const selections: { materialId: string; versionId: string }[] = [];
  for (const [index, text] of outputFixtureTexts.entries()) {
    const material = await workspace.registerText({ caseId: record.id, text, sourceLabel: `虚构材料${index + 1}` });
    selections.push({ materialId: material.id, versionId: material.id });
  }
  const model = createOutputFixtureModel();
  const run = await organizeCaseInformation({ dataDir, caseId: record.id, model, plan: { goal: '整理付款记载和口头讲话，保留差异与日期未知项',
    selections, needs, limits: { maxRounds: 4, maxReads: 12 } } });
  return { cases, workspace, record, selections, run, needs, model };
}
