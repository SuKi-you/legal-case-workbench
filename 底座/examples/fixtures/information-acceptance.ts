import type { InformationEntity, InformationRecord, StructuredNeed } from '../../src/information/contracts.ts';

/** Independently specified, source-specific facts used only by the acceptance grader. */
export interface InformationAcceptanceFact {
  id: string;
  sourceIndex: number;
  needId: string;
  topic: string;
  subject: InformationEntity | null;
  object: InformationEntity | null;
  attributedTo: InformationEntity | null;
  eventKey: string | null;
  value: {
    kind: InformationRecord['value']['kind'];
    normalized?: string | null;
    unit: string | null;
    rawIncludes: string[];
    rawExcludes?: string[];
  };
  polarity: InformationRecord['polarity'];
  period: string | null;
  basis: string | null;
  time: {
    allowedRanges: Pick<InformationRecord['time'], 'precision' | 'start' | 'end'>[];
    rawIncludes?: string[];
    rawExcludes?: string[];
    rawMustBeNull?: boolean;
  };
}

export interface InformationAcceptanceCase {
  id: string;
  title: string;
  goal: string;
  materials: { sourceLabel: string; text: string; kind: 'party_statement' | 'document_record' }[];
  needs: StructuredNeed[];
  /** Evaluation metadata only. Never include this object in model inputs. */
  expected: {
    facts: InformationAcceptanceFact[];
    inconsistentSourcePairs: [number, number][];
    equivalentSourcePairs: [number, number][];
    /** Source pairs whose subjects have explicitly different identities. */
    separateSubjectSources?: [number, number][];
    minEquivalentClaims: number;
    expectedAmounts: string[];
    relativeTimeMustStayUnknown?: boolean;
  };
}

const person = (name: string, value: string | null): InformationEntity => ({ name, kind: 'person',
  identity: value === null ? null : { scheme: 'personnel_id', value } });
const recipient: InformationEntity = { name: '星河服务中心', kind: 'organization', identity: { scheme: 'registration_id', value: 'R203' } };
const date = (value: string) => ({ precision: 'date' as const, start: value, end: value });
const unresolved = { precision: 'unknown' as const, start: null, end: null };
const relative = { precision: 'relative' as const, start: null, end: null };
const transferFact = (sourceIndex: number, normalized: string, raw: string): InformationAcceptanceFact => ({
  id: `transfer-${sourceIndex}`, sourceIndex, needId: 'acceptance.transfer-amount', topic: 'transfer.actual_received_amount',
  subject: person('周岚', 'P014'), object: recipient, attributedTo: sourceIndex === 1 ? person('周岚', 'P014') : null,
  eventKey: 'TX-2025-0416-009', value: { kind: 'money', normalized, unit: 'CNY', rawIncludes: [raw] },
  polarity: 'affirmed', period: '2025-04', basis: '实际到账', time: { allowedRanges: [date('2025-04-16')] },
});
const monthlyFact = (sourceIndex: number, identity: string, month: '03' | '04', basis: string, amount: string): InformationAcceptanceFact => ({
  id: `monthly-${sourceIndex}`, sourceIndex, needId: 'acceptance.monthly-amounts', topic: 'compensation.monthly_amount',
  subject: person('王琳', identity), object: null, attributedTo: null, eventKey: null,
  value: { kind: 'money', normalized: amount, unit: 'CNY', rawIncludes: [amount] }, polarity: 'affirmed', period: `2025-${month}`, basis,
  time: { allowedRanges: [date(`2025-${month}-${month === '03' ? '31' : '30'}`),
    { precision: 'month', start: `2025-${month}-01`, end: `2025-${month}-${month === '03' ? '31' : '30'}` }] },
});
const oralFact = (sourceIndex: number): InformationAcceptanceFact => ({
  id: `oral-${sourceIndex}`, sourceIndex, needId: 'acceptance.oral-statement', topic: 'attendance.oral_instruction',
  subject: person('赵敏', null), object: person('陈宁', 'W017'), attributedTo: person('陈宁', 'W017'), eventKey: null,
  value: { kind: 'text', unit: null, rawIncludes: ['你明天不用来上班了'], rawExcludes: ['没有再联系', '书面通知', '之后'] },
  polarity: 'affirmed', period: null, basis: null,
  time: sourceIndex === 0 ? { allowedRanges: [relative], rawIncludes: ['上周'] }
    : { allowedRanges: [unresolved, relative], rawExcludes: ['之后', '以后', '补充说明时', '截至'] },
});

/**
 * Fictional acceptance inputs, authored separately from the extraction prompt and
 * parser implementation. Materials are not authentic evidence or legal advice.
 * Pass only goal/materials/needs to the application; keep expected in the grader.
 */
export const acceptanceCases: InformationAcceptanceCase[] = [
  {
    id: 'transfer-multiple-records',
    title: '同一笔款项的多来源金额记载',
    goal: '逐份整理付款记载及其出处，对涉及同一交易的金额记载进行核对。',
    materials: [
      {
        sourceLabel: '模拟转账回单摘录', kind: 'document_record',
        text: '【虚构转账回单】周岚（人员编号 P014）向星河服务中心（登记编号 R203）付款。'
          + '流水号：TX-2025-0416-009。付款日期：2025年4月16日。所属期间：2025年4月。'
          + '金额口径：实际到账。币种：人民币。该笔实际到账金额：人民币1.25万元。',
      },
      {
        sourceLabel: '模拟付款人情况说明', kind: 'party_statement',
        text: '周岚（人员编号 P014）陈述：我在2025年4月16日向星河服务中心（登记编号 R203）付过这笔款。'
          + '这次付款的流水号是 TX-2025-0416-009，所属期间是2025年4月。'
          + '我这里记载的金额口径是实际到账，币种是人民币，记下的是人民币12500.00元。',
      },
      {
        sourceLabel: '模拟收款登记摘录', kind: 'document_record',
        text: '【虚构收款登记】登记事项：周岚（人员编号 P014）向星河服务中心（登记编号 R203）的付款。'
          + '对应流水号 TX-2025-0416-009，付款日期2025年4月16日，所属期间2025年4月。'
          + '金额口径：实际到账。币种：人民币。本登记列示该笔实际到账金额为人民币12000元。',
      },
    ],
    needs: [{
      id: 'acceptance.transfer-amount',
      question: '各份材料分别记载了这笔付款的什么实际到账金额，以及相应交易条件？',
      reason: '保留各份来源的交易记载，核对能够对应的交易条件和金额。',
      spec: {
        topic: 'transfer.actual_received_amount', subject: '周岚', object: '星河服务中心',
        period: '2025-04', basis: '实际到账',
        requiredFields: ['subject', 'object', 'event.key', 'time', 'value', 'period', 'basis'],
        minimumSupport: 'statement', applicable: true,
      },
    }],
    expected: {
      facts: [transferFact(0, '12500', '1.25万'), transferFact(1, '12500', '12500.00'), transferFact(2, '12000', '12000')],
      inconsistentSourcePairs: [[0, 2], [1, 2]], equivalentSourcePairs: [[0, 1]], minEquivalentClaims: 1, expectedAmounts: ['12500', '12000'],
    },
  },
  {
    id: 'identity-period-and-basis',
    title: '多个人物、月份与口径的金额记录',
    goal: '整理各人的月度金额记载，核对人物身份、所属月份和金额口径，再说明记录之间的关系。',
    materials: [
      {
        sourceLabel: '模拟三月金额记录甲', kind: 'document_record',
        text: '【虚构金额记录】星桥公司员工王琳，人员编号 EMP101。所属期间：2025年3月。'
          + '记录日期：2025年3月31日。金额口径：税前。币种：人民币。该月记载金额为人民币8000元。',
      },
      {
        sourceLabel: '模拟三月金额记录乙', kind: 'document_record',
        text: '【虚构金额记录】星桥公司员工王琳，人员编号 EMP202。所属期间：2025年3月。'
          + '记录日期：2025年3月31日。金额口径：税前。币种：人民币。该月记载金额为人民币6000元。',
      },
      {
        sourceLabel: '模拟四月金额记录', kind: 'document_record',
        text: '【虚构金额记录】星桥公司员工王琳，人员编号 EMP101。所属期间：2025年4月。'
          + '记录日期：2025年4月30日。金额口径：税前。币种：人民币。该月记载金额为人民币9000元。',
      },
      {
        sourceLabel: '模拟三月另一口径记录', kind: 'document_record',
        text: '【虚构金额记录】星桥公司员工王琳，人员编号 EMP101。所属期间：2025年3月。'
          + '记录日期：2025年3月31日。金额口径：实发。币种：人民币。该月记载金额为人民币6200元。',
      },
    ],
    needs: [{
      id: 'acceptance.monthly-amounts',
      question: '这些材料分别记载了哪个人的哪个月份、什么口径的金额？',
      reason: '把金额和所属人物、期间及口径一并保留，供后续核对。',
      spec: {
        topic: 'compensation.monthly_amount', subject: null, object: null, period: null, basis: null,
        requiredFields: ['subject', 'time', 'value', 'period', 'basis'],
        minimumSupport: 'statement', applicable: true,
      },
    }],
    expected: {
      facts: [monthlyFact(0, 'EMP101', '03', '税前', '8000'), monthlyFact(1, 'EMP202', '03', '税前', '6000'),
        monthlyFact(2, 'EMP101', '04', '税前', '9000'), monthlyFact(3, 'EMP101', '03', '实发', '6200')],
      inconsistentSourcePairs: [], equivalentSourcePairs: [], separateSubjectSources: [[0, 1], [1, 2], [1, 3]],
      minEquivalentClaims: 0, expectedAmounts: ['8000', '6000', '9000', '6200'],
    },
  },
  {
    id: 'oral-statement-and-relative-time',
    title: '口头讲话与后续安排的接案陈述',
    goal: '整理当事人已经提供的口头讲话和后续安排陈述，保留说话归属、否定表达及尚不明确的时间。',
    materials: [
      {
        sourceLabel: '模拟接案初次陈述', kind: 'party_statement',
        text: '我叫陈宁，人员编号 W017，在星桥公司工作。上周，主管赵敏口头对我说：“你明天不用来上班了。”'
          + '我目前说不清那天的具体日期。这段记录是我对当时谈话的回忆。',
      },
      {
        sourceLabel: '模拟接案补充陈述', kind: 'party_statement',
        text: '陈宁（人员编号 W017）补充说明：从主管赵敏说“你明天不用来上班了”之后，到这次补充说明时，'
          + '星桥公司没有再联系我安排工作。这里的“没有再联系”只描述这段时间内公司的联系情况。'
          + '我没有说自己曾收到书面通知。',
      },
    ],
    needs: [
      {
        id: 'acceptance.oral-statement',
        question: '当事人对主管的口头讲话已经提供了哪些具体说法？',
        reason: '保存现有陈述的内容与归属，供承办人核查。',
        spec: {
          topic: 'attendance.oral_instruction', subject: null, object: null, period: null, basis: null,
          requiredFields: [], minimumSupport: 'statement', applicable: true,
        },
      },
      {
        id: 'acceptance.follow-up-arrangement',
        question: '当事人怎样描述口头讲话之后公司的工作安排联系情况？',
        reason: '保留已经提供的后续安排陈述及其描述范围。',
        spec: {
          topic: 'attendance.subsequent_contact', subject: null, object: null, period: null, basis: null,
          requiredFields: [], minimumSupport: 'statement', applicable: true,
        },
      },
    ],
    expected: {
      facts: [oralFact(0), oralFact(1), {
        id: 'subsequent-contact-1', sourceIndex: 1, needId: 'acceptance.follow-up-arrangement', topic: 'attendance.subsequent_contact',
        subject: { name: '星桥公司', kind: 'organization', identity: null }, object: person('陈宁', 'W017'),
        attributedTo: person('陈宁', 'W017'), eventKey: null,
        value: { kind: 'text', unit: null, rawIncludes: ['没有再联系'], rawExcludes: ['书面通知', '从未', '从来没有'] },
        polarity: 'denied', period: null, basis: null,
        time: { allowedRanges: [relative], rawIncludes: ['之后', '这次补充说明时'] },
      }],
      inconsistentSourcePairs: [], equivalentSourcePairs: [], minEquivalentClaims: 0, expectedAmounts: [], relativeTimeMustStayUnknown: true,
    },
  },
];
