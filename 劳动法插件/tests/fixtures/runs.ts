/**
 * 测试夹具：两份可以通过底座 loopRunSchema 校验的运行记录。
 *
 * 刻意手写而不是从磁盘读：这些案件是虚构的，不含任何真实当事人信息，
 * 也不依赖 OCR、模型或网络。
 */
import type { LoopRun } from '../../../底座/src/loops/contracts.ts';

const TEXTSHA = 'a'.repeat(64);
const CASE_ID = '0b5f7d2e-1c3a-4e5f-8a9b-0c1d2e3f4a5b';
const MATERIAL_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const VERSION_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

const sourceRef = { materialId: MATERIAL_ID, versionId: VERSION_ID, textSha256: TEXTSHA };

let sequence = 0;
const uuid = (): string => {
  sequence += 1;
  const tail = String(sequence).padStart(12, '0');
  return `4d5e6f7a-8b9c-4da0-9f2a-${tail}`;
};

interface RecordInput {
  topic: string;
  key: string;
  description: string;
  period?: string | null;
  start?: string | null;
  value?: string | null;
  polarity?: 'affirmed' | 'denied' | 'uncertain';
  origin?: 'party_statement' | 'document_record' | 'inference';
  subjectName?: string | null;
  attributedName?: string | null;
}

function record(input: RecordInput) {
  const entity = (name: string | null | undefined) => (name ? { name, kind: 'person' as const, identity: null } : null);
  return {
    topic: input.topic,
    subject: entity(input.subjectName ?? '张某'),
    object: entity('某科技有限公司'),
    attributedTo: entity(input.attributedName),
    event: { type: input.topic, key: input.key, description: input.description },
    time: { raw: input.start ?? null, start: input.start ?? null, end: input.start ?? null, precision: input.start ? 'date' as const : 'unknown' as const },
    value: { kind: input.value ? 'money' as const : 'unknown' as const, raw: input.value ?? null, normalized: input.value ?? null, unit: input.value ? '元' : null },
    polarity: input.polarity ?? 'affirmed' as const,
    period: input.period ?? null,
    basis: null as string | null,
    origin: input.origin ?? 'document_record' as const,
    qualifiers: {} as Record<string, string>,
    uncertainty: [] as string[],
  };
}

interface FindingInput extends RecordInput {
  needId: string;
  statement: string;
}

function finding(input: FindingInput) {
  return {
    id: uuid(),
    needId: input.needId,
    statement: input.statement,
    citations: [{ ...sourceRef, start: 0, end: 10, quote: input.statement.slice(0, 10) }],
    record: record(input),
  };
}

interface CoverageOverride {
  coverage?: 'found' | 'partial' | 'not_found_in_examined' | 'unread';
  consistency?: 'consistent' | 'ambiguous' | 'conflicting';
  support?: 'statement_only' | 'document_supported' | 'inference_only' | 'none';
  satisfaction?: 'satisfied' | 'needs_review' | 'needs_information' | 'not_applicable';
  missingFields?: string[];
}

function coverage(needId: string, over: CoverageOverride = {}, findingIds: string[] = []) {
  const coverageState = over.coverage ?? 'not_found_in_examined';
  return {
    needId,
    findingIds,
    conflictIds: [] as string[],
    coverage: coverageState,
    consistency: over.consistency ?? ('consistent' as const),
    support: over.support ?? ('none' as const),
    satisfaction: over.satisfaction ?? ('needs_information' as const),
    missingFields: over.missingFields ?? [],
    examined: coverageState === 'unread' ? [] : [sourceRef],
    unread: coverageState === 'unread' ? [sourceRef] : [],
    reason: coverageState === 'unread' ? '尚未读取该来源' : '已核对本次选定来源',
    nextActions: [] as { kind: 'read' | 'clarify' | 'review'; needId: string; reason: string; instruction: string }[],
  };
}

const NEEDS = [
  'labor.need.subject', 'labor.need.work', 'labor.need.subordination', 'labor.need.business', 'labor.need.pay',
  'labor.need.relation.form', 'labor.need.work.hours',
  'labor.need.wage-standard', 'labor.need.wage-payment', 'labor.need.wage-period', 'labor.need.wage-unpaid', 'labor.need.overtime',
  'labor.need.term.by-employer', 'labor.need.term.by-employee', 'labor.need.term.by-agreement',
  'labor.need.term-form', 'labor.need.term-date', 'labor.need.term-reason', 'labor.need.term-lastday',
  'labor.need.tenure', 'labor.need.wage-base12', 'labor.need.double-start', 'labor.need.double-signed', 'labor.need.double-period',
  'labor.need.general',
] as const;

const need = (id: string) => ({ id, question: `${id} 需要提取什么`, reason: '测试夹具' });

function build(input: {
  id: string;
  goal: string;
  findings: ReturnType<typeof finding>[];
  overrides: Record<string, CoverageOverride>;
  status?: 'completed' | 'needs_review' | 'stalled' | 'limit_reached';
}): LoopRun {
  const findings = input.findings;
  const needs = NEEDS.map((id) => {
    const over = input.overrides[id] ?? {};
    const covered = over.coverage === 'found' || over.coverage === 'partial';
    return coverage(id, over, covered ? findings.filter((item) => item.needId === id).map((item) => item.id) : []);
  });

  return {
    id: input.id,
    caseId: CASE_ID,
    baseCaseRevision: 1,
    goal: input.goal,
    createdAt: '2026-11-01T00:00:00.000Z',
    finishedAt: '2026-11-01T00:05:00.000Z',
    sources: [sourceRef],
    providers: {
      declare: { capability: { id: 'information.declare', version: 1 }, pluginId: 'information.needs-and-review', pluginVersion: '1.0.0' },
      read: { capability: { id: 'information.read', version: 1 }, pluginId: 'information.reader', pluginVersion: '1.0.0' },
      review: { capability: { id: 'information.review', version: 1 }, pluginId: 'information.needs-and-review', pluginVersion: '1.0.0' },
    },
    limits: { maxRounds: 12, maxReads: 60 },
    needs: NEEDS.map((id) => need(id)),
    findings,
    rounds: [],
    status: input.status ?? 'completed',
    reason: '测试夹具：整理完成',
    information: { version: 1, entities: [], relations: [], conflicts: [], needs },
  };
}

/** 场景 A：工资支付，4—8 月中缺 6 月。 */
export const WAGE_GAP_RUN: LoopRun = build({
  id: '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f',
  goal: '整理张某与某科技有限公司的工资支付情况，判断能否主张欠薪。',
  findings: [
    finding({ needId: 'labor.need.wage-standard', statement: '约定月工资 6000 元', topic: 'labor.wage.standard', key: '工资约定', description: '口头约定月工资 6000 元', value: '6000' }),
    finding({ needId: 'labor.need.wage-payment', statement: '2024 年 4 月工资 6000 元已转账', topic: 'labor.wage.payment', key: '工资发放', description: '4 月工资已转账', period: '2024-04', start: '2024-04-10', value: '6000' }),
    finding({ needId: 'labor.need.wage-payment', statement: '2024 年 5 月工资 6000 元已转账', topic: 'labor.wage.payment', key: '工资发放', description: '5 月工资已转账', period: '2024-05', start: '2024-05-10', value: '6000' }),
    finding({ needId: 'labor.need.wage-payment', statement: '2024 年 7 月工资 6000 元已转账', topic: 'labor.wage.payment', key: '工资发放', description: '7 月工资已转账', period: '2024-07', start: '2024-07-10', value: '6000' }),
    finding({ needId: 'labor.need.wage-payment', statement: '2024 年 8 月工资 6000 元已转账', topic: 'labor.wage.payment', key: '工资发放', description: '8 月工资已转账', period: '2024-08', start: '2024-08-10', value: '6000' }),
    finding({ needId: 'labor.need.wage-unpaid', statement: '2024 年 6 月工资至今未发', topic: 'labor.wage.unpaid', key: '欠发工资', description: '6 月工资未发', period: '2024-06', value: '6000' }),
    finding({ needId: 'labor.need.work', statement: '2024 年 3 月 1 日开始上班', topic: 'labor.work', key: '入职', description: '3 月 1 日入职', start: '2024-03-01' }),
    finding({ needId: 'labor.need.subordination', statement: '主管在微信群排班并审批请假', topic: 'labor.management', key: '劳动管理', description: '微信群排班、审批请假', start: '2024-04-02', origin: 'party_statement' }),
  ],
  overrides: {
    'labor.need.work': { coverage: 'found', support: 'statement_only', satisfaction: 'satisfied' },
    'labor.need.subordination': { coverage: 'found', support: 'statement_only', satisfaction: 'satisfied' },
    'labor.need.wage-standard': { coverage: 'found', support: 'document_supported', satisfaction: 'satisfied' },
    'labor.need.wage-payment': { coverage: 'found', support: 'document_supported', satisfaction: 'satisfied' },
    'labor.need.wage-unpaid': { coverage: 'found', support: 'statement_only', satisfaction: 'satisfied' },
  },
});

/** 场景 B：口头解除，提出方、方式、时间都只有陈述。 */
export const TERMINATION_RUN: LoopRun = build({
  id: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a80',
  goal: '整理某科技有限公司口头通知张某"别来了"的解除经过，判断能否主张赔偿金。',
  findings: [
    finding({ needId: 'labor.need.term.by-employer', statement: '主管 6 月 15 日说"你别来了"', topic: 'labor.term.by-employer', key: '单位提出解除', description: '主管口头通知不用再来', start: '2025-06-15', attributedName: '主管王某', origin: 'party_statement' }),
    finding({ needId: 'labor.need.term-form', statement: '公司没有出具书面通知', topic: 'labor.term.form', key: '口头解除', description: '未出具书面解除通知', start: '2025-06-15', polarity: 'denied', origin: 'party_statement' }),
    finding({ needId: 'labor.need.term-date', statement: '2025 年 6 月 15 日被通知解除', topic: 'labor.term.date', key: '解除日', description: '6 月 15 日当天被通知', start: '2025-06-15', origin: 'party_statement' }),
    finding({ needId: 'labor.need.tenure', statement: '2022 年 3 月 1 日入职，2025 年 6 月 15 日解除', topic: 'labor.tenure', key: '工作年限', description: '入职三年三个月', start: '2022-03-01', origin: 'party_statement' }),
    finding({ needId: 'labor.need.wage-base12', statement: '解除前十二个月平均工资 8000 元', topic: 'labor.wage.base12', key: '月平均工资', description: '前十二个月平均 8000 元', period: '2025-05', value: '8000' }),
  ],
  overrides: {
    'labor.need.term.by-employer': { coverage: 'found', support: 'statement_only', satisfaction: 'satisfied' },
    'labor.need.term-form': { coverage: 'found', support: 'statement_only', satisfaction: 'satisfied' },
    'labor.need.term-date': { coverage: 'found', support: 'statement_only', satisfaction: 'satisfied' },
    'labor.need.tenure': { coverage: 'found', support: 'statement_only', satisfaction: 'satisfied' },
    'labor.need.wage-base12': { coverage: 'found', support: 'document_supported', satisfaction: 'satisfied' },
  },
});
