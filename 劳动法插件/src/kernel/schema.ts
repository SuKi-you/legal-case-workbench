/**
 * 通用结构层 · 校验
 *
 * 两件事：
 * 1) 手写 Standard Schema 实现（不依赖 zod），让插件零安装即可被底座目录加载；
 * 2) 知识包完整性校验——结构化面试之后必须过的关，避免"半成品插件"上线。
 */
import {
  MATERIAL_KINDS, RECORD_FIELDS, ELEMENT_STATES, type DomainKnowledge, type MaterialKind, type RecordField,
} from './contracts.ts';
import { checkConditionProblems } from './check-conditions.ts';

// ── 最小 Standard Schema 实现 ────────────────────────────────────────
export interface LocalSchemaIssue {
  readonly message: string;
  readonly path?: readonly (string | number)[];
}

export interface LocalSchema<T> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: 'law-agent/domain-plugin';
    readonly validate: (value: unknown) => { readonly value: T } | { readonly issues: readonly LocalSchemaIssue[] };
  };
}

export interface FieldSpec {
  readonly type: 'string' | 'number' | 'boolean';
  readonly description: string;
  readonly optional?: boolean;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface ObjectInput<T extends Record<string, unknown>> {
  /** 交给底座 AgentToolCatalog 做输入校验。 */
  readonly input: LocalSchema<T>;
  /** 交给模型的 JSON Schema；与 input 由同一份声明派生，不会漂移。 */
  readonly inputSchema: Record<string, unknown>;
}

type FieldNames = Record<string, FieldSpec>;

export function objectInput<T extends Record<string, unknown>>(fields: FieldNames): ObjectInput<T> {
  const entries = Object.entries(fields);

  const check = (value: unknown): LocalSchemaIssue[] => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [{ message: '输入必须是对象。' }];
    }
    const record = value as Record<string, unknown>;
    const issues: LocalSchemaIssue[] = [];
    for (const key of Object.keys(record)) {
      if (!(key in fields)) issues.push({ message: `不认识的字段：${key}`, path: [key] });
    }
    for (const [name, spec] of entries) {
      const item = record[name];
      if (item === undefined) {
        if (spec.optional !== true) issues.push({ message: `缺少必填字段：${name}`, path: [name] });
        continue;
      }
      if (typeof item !== spec.type) {
        issues.push({ message: `${name} 必须是 ${spec.type}。`, path: [name] });
        continue;
      }
      if (spec.enum && (typeof item !== 'string' || !spec.enum.includes(item))) {
        issues.push({ message: `${name} 必须是 ${spec.enum.join(' / ')} 之一。`, path: [name] });
      }
      if (typeof item === 'number') {
        if (spec.minimum !== undefined && item < spec.minimum) issues.push({ message: `${name} 不能小于 ${spec.minimum}。`, path: [name] });
        if (spec.maximum !== undefined && item > spec.maximum) issues.push({ message: `${name} 不能大于 ${spec.maximum}。`, path: [name] });
        if (!Number.isFinite(item)) issues.push({ message: `${name} 必须是有限数字。`, path: [name] });
      }
    }
    return issues;
  };

  const inputSchema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(entries.map(([name, spec]) => {
      const property: Record<string, unknown> = { type: spec.type, description: spec.description };
      if (spec.enum) property.enum = [...spec.enum];
      if (spec.minimum !== undefined) property.minimum = spec.minimum;
      if (spec.maximum !== undefined) property.maximum = spec.maximum;
      return [name, property];
    })),
    required: entries.filter(([, spec]) => spec.optional !== true).map(([name]) => name),
  };

  return {
    inputSchema,
    input: {
      '~standard': {
        version: 1,
        vendor: 'law-agent/domain-plugin',
        validate(value: unknown) {
          const issues = check(value);
          return issues.length > 0 ? { issues } : { value: value as T };
        },
      },
    },
  };
}

// ── 知识包完整性校验 ─────────────────────────────────────────────────
const asSet = <T extends string>(values: readonly T[]): Set<string> => new Set(values);

/**
 * 只做结构自洽，不判断法律内容对错。
 * 返回非空即视为知识包不合格，不允许装配成插件。
 */
export function validateKnowledge(knowledge: DomainKnowledge): string[] {
  const problems: string[] = [];
  const say = (message: string): void => { problems.push(message); };

  if (!knowledge.id.trim()) say('知识包缺少 id。');
  if (!knowledge.version.trim()) say('知识包缺少 version。');
  if (!knowledge.domain.trim()) say('知识包缺少 domain。');
  if (!['claimant', 'respondent', 'neutral'].includes(knowledge.stance)) say(`stance 非法：${String(knowledge.stance)}`);

  const materialKinds = asSet(MATERIAL_KINDS);
  const elementStates = asSet(ELEMENT_STATES);
  const sourceIds = new Set(Object.keys(knowledge.sources));

  // 法源
  for (const [id, source] of Object.entries(knowledge.sources)) {
    if (source.id !== id) say(`法源 ${id} 的 id 与键名不一致。`);
    if (!source.title.trim()) say(`法源 ${id} 缺少 title。`);
    if (!['in-force', 'repealed', 'historical', 'unverified'].includes(source.validity)) say(`法源 ${id} 的 validity 非法。`);
    if (!['statute', 'retrieval', 'model'].includes(source.authorityLevel)) say(`法源 ${id} 的 authorityLevel 非法。`);
    if (source.validity === 'repealed' && !source.note) say(`法源 ${id} 已废止，必须写明 note（不得作为现行依据）。`);
  }

  // 要件
  const elementIds = new Set<string>();
  for (const element of knowledge.elements) {
    if (elementIds.has(element.id)) say(`要件 id 重复：${element.id}`);
    elementIds.add(element.id);
    if (!element.title.trim()) say(`要件 ${element.id} 缺少 title。`);
    if (element.needs.length === 0) say(`要件 ${element.id} 没有对应信息需求。`);
    for (const need of element.needs) if (!need.trim()) say(`要件 ${element.id} 含空的 need id。`);
    if (element.expectedPolarity !== undefined && !['affirmed', 'denied'].includes(element.expectedPolarity)) say(`要件 ${element.id} 的命题肯否要求非法。`);
    if (!['factual', 'evaluative'].includes(element.kind)) say(`要件 ${element.id} 的 kind 非法。`);
    if (!['claimant', 'respondent', 'shared', 'authority'].includes(element.burden)) say(`要件 ${element.id} 的 burden 非法。`);
    if (element.materials.length === 0) say(`要件 ${element.id} 未声明可证明它的材料类型。`);
    for (const kind of element.materials) if (!materialKinds.has(kind)) say(`要件 ${element.id} 的材料类型非法：${String(kind)}`);
    for (const source of element.statute ?? []) if (!sourceIds.has(source)) say(`要件 ${element.id} 引用了不存在的法源：${source}`);
    if (element.minimumSupport === 'document' && !element.materials.some((kind) => kind !== 'statement')) {
      say(`要件 ${element.id} 要求书证，但只声明了陈述类材料。`);
    }
    for (const shift of element.burdenShift ?? []) {
      if (shift.when.length === 0) say(`要件 ${element.id} 的举证转移条件为空，会导致无条件转移。`);
      if (!shift.reason.trim()) say(`要件 ${element.id} 的举证转移缺少 reason。`);
      if (!['claimant', 'respondent', 'shared', 'authority'].includes(shift.then)) say(`要件 ${element.id} 的举证转移目标非法。`);
      for (const condition of shift.when) {
        if (condition.elementId === undefined && condition.signal === undefined) say(`要件 ${element.id} 的举证转移含空条件。`);
        if (condition.elementId !== undefined && !elementIds.has(condition.elementId)) {
          say(`要件 ${element.id} 的举证转移引用了不存在的要件：${condition.elementId}`);
        }
        if (condition.elementId !== undefined && (condition.in === undefined || condition.in.length === 0)) {
          say(`要件 ${element.id} 的举证转移含空状态集合（${condition.elementId}）。`);
        }
        if (condition.signal !== undefined && !condition.signal.trim()) say(`要件 ${element.id} 的举证转移含空线索词。`);
      }
    }
  }

  // 抗辩（先收 id，路径的 blockedBy 会引用它）
  const defenseIds = new Set<string>();
  for (const defense of knowledge.defenses ?? []) {
    if (defenseIds.has(defense.id)) say(`抗辩 id 重复：${defense.id}`);
    defenseIds.add(defense.id);
    if (!defense.name.trim()) say(`抗辩 ${defense.id} 缺少 name。`);
    if (defense.against.length === 0) say(`抗辩 ${defense.id} 没有声明针对哪个争点。`);
    if (defense.response.length === 0) say(`抗辩 ${defense.id} 未给出我方应对材料。`);
    if (!['block', 'reduce', 'shift_burden'].includes(defense.effect)) say(`抗辩 ${defense.id} 的 effect 非法。`);
    for (const elementId of defense.requires.map((item) => item.elementId)) {
      if (!elementIds.has(elementId)) say(`抗辩 ${defense.id} 引用了不存在的要件：${elementId}`);
    }
    if (defense.claim && (!defense.claim.needId.trim() || defense.claim.values.length === 0 || defense.claim.values.some((value) => !value.trim()) || !knowledge.elements.some((element) => element.needs.includes(defense.claim!.needId)))) say(`抗辩 ${defense.id} 的结构化主张条件无效。`);
    for (const expectation of defense.requires) if (expectation.in.some((state) => !elementStates.has(state))) say(`抗辩 ${defense.id} 含非法要件状态。`);
    for (const source of defense.statute) if (!sourceIds.has(source)) say(`抗辩 ${defense.id} 引用了不存在的法源：${source}`);
    for (const signal of defense.signals ?? []) if (!signal.trim()) say(`抗辩 ${defense.id} 含空的线索词。`);
  }

  // 争点
  if (knowledge.issues.length === 0) say('知识包至少需要一个争点。');
  const issueIds = new Set<string>();
  const claimedElements = new Set<string>();
  for (const issue of knowledge.issues) {
    if (issueIds.has(issue.id)) say(`争点 id 重复：${issue.id}`);
    issueIds.add(issue.id);
    if (!issue.title.trim()) say(`争点 ${issue.id} 缺少 title。`);
    if (issue.elements.length === 0) say(`争点 ${issue.id} 没有要件。`);
    for (const elementId of issue.elements) {
      if (!elementIds.has(elementId)) { say(`争点 ${issue.id} 引用了不存在的要件：${elementId}`); continue; }
      if (claimedElements.has(elementId)) say(`要件 ${elementId} 被多个争点引用，归属不唯一。`);
      claimedElements.add(elementId);
      const owner = knowledge.elements.find((element) => element.id === elementId);
      if (owner && owner.issueId !== issue.id) say(`要件 ${elementId} 的 issueId 与所属争点 ${issue.id} 不一致。`);
    }
    if (issue.rules.length === 0) say(`争点 ${issue.id} 没有任何判定规则。`);
    const last = issue.rules.at(-1);
    if (last && last.all.length > 0) say(`争点 ${issue.id} 的最后一条规则必须是兜底（all 为空），否则可能出现无法归类的状态。`);
    for (const rule of issue.rules) {
      for (const expectation of rule.all) {
        if (!issue.elements.includes(expectation.elementId)) say(`争点 ${issue.id} 的规则引用了不属于它的要件：${expectation.elementId}`);
        if (expectation.in.some((state) => !elementStates.has(state))) say(`规则引用了非法要件状态。`);
        if (expectation.in.length === 0) say(`争点 ${issue.id} 的规则含空状态集合（${expectation.elementId}）。`);
      }
      if (!['judgeable', 'disputed', 'insufficient', 'not_applicable'].includes(rule.then)) say(`争点 ${issue.id} 的规则结论非法。`);
    }
    const pathIds = new Set<string>();
    for (const path of issue.paths ?? []) {
      if (pathIds.has(path.id)) say(`争点 ${issue.id} 的路径 id 重复：${path.id}`);
      pathIds.add(path.id);
      if (!path.name.trim() || !path.outcome.trim() || !path.reason.trim()) say(`路径 ${path.id} 的 name/outcome/reason 不能为空。`);
      if (path.requires.length === 0) say(`路径 ${path.id} 没有声明成立条件。`);
      for (const expectation of path.requires) {
        if (!issue.elements.includes(expectation.elementId)) say(`路径 ${path.id} 引用了不属于本争点的要件：${expectation.elementId}`);
        if (expectation.in.some((state) => !elementStates.has(state))) say(`规则引用了非法要件状态。`);
        if (expectation.in.length === 0) say(`路径 ${path.id} 含空状态集合（${expectation.elementId}）。`);
      }
      for (const defenseId of path.blockedBy ?? []) {
        if (!defenseIds.has(defenseId)) say(`路径 ${path.id} 引用了不存在的抗辩：${defenseId}`);
      }
      for (const source of path.statute) if (!sourceIds.has(source)) say(`路径 ${path.id} 引用了不存在的法源：${source}`);
      if (path.calcPath !== undefined && !path.calcPath.trim()) say(`路径 ${path.id} 的 calcPath 不能为空字符串。`);
    }
    for (const hint of issue.routing ?? []) {
      for (const source of hint.sourceIds ?? []) if (!sourceIds.has(source)) say(`争点 ${issue.id} 的分流引用了不存在的法源：${source}`);
    }
  }

  // 抗辩针对的争点必须存在
  for (const defense of knowledge.defenses ?? []) {
    for (const issueId of defense.against) {
      if (!issueIds.has(issueId)) say(`抗辩 ${defense.id} 针对了不存在的争点：${issueId}`);
    }
  }

  // 专业校验
  const checkIds = new Set<string>();
  for (const check of knowledge.checks ?? []) {
    if (checkIds.has(check.id)) say(`校验 id 重复：${check.id}`);
    checkIds.add(check.id);
    if (!check.title.trim() || !check.message.trim()) say(`校验 ${check.id} 的 title/message 不能为空。`);
    if (!['info', 'warn', 'critical'].includes(check.severity)) say(`校验 ${check.id} 的 severity 非法。`);
    problems.push(...checkConditionProblems(check, knowledge.elements));
    for (const source of check.statute) if (!sourceIds.has(source)) say(`校验 ${check.id} 引用了不存在的法源：${source}`);
  }
  // 评价性要件的提问模板
  const opinionIds = new Set<string>();
  for (const opinion of knowledge.opinions ?? []) {
    if (opinionIds.has(opinion.elementId)) say(`评价性要件的提问模板重复：${opinion.elementId}`);
    opinionIds.add(opinion.elementId);
    const element = knowledge.elements.find((item) => item.id === opinion.elementId);
    if (!element) { say(`提问模板引用了不存在的要件：${opinion.elementId}`); continue; }
    if (element.kind !== 'evaluative') say(`提问模板只能用于评价性要件：${opinion.elementId} 声明为 ${element.kind}`);
    if (!opinion.question.trim()) say(`提问模板缺少 question：${opinion.elementId}`);
    if (opinion.factors.length === 0) say(`提问模板没有任何必看因素：${opinion.elementId}`);
    for (const factor of opinion.factors) if (!factor.trim()) say(`提问模板含空因素：${opinion.elementId}`);
  }

  // 事实因子
  const factorIds = new Set<string>();
  for (const factor of knowledge.factors ?? []) {
    if (factorIds.has(factor.id)) say(`因子 id 重复：${factor.id}`);
    factorIds.add(factor.id);
    if (!factor.title.trim() || !factor.note.trim()) say(`因子 ${factor.id} 的 title/note 不能为空。`);
    if (!issueIds.has(factor.issueId)) say(`因子 ${factor.id} 引用了不存在的争点：${factor.issueId}`);
    if (factor.parts.length === 0) say(`因子 ${factor.id} 没有参与加权的要件。`);
    for (const part of factor.parts) {
      if (!elementIds.has(part.elementId)) { say(`因子 ${factor.id} 引用了不存在的要件：${part.elementId}`); continue; }
      if (!(part.weight > 0) || !Number.isFinite(part.weight)) say(`因子 ${factor.id} 的权重必须为正数：${part.elementId}`);
      const owner = knowledge.elements.find((element) => element.id === part.elementId);
      if (owner && owner.issueId !== factor.issueId) say(`因子 ${factor.id} 引用了别的争点的要件：${part.elementId}`);
    }
    if (factor.bands.length === 0) say(`因子 ${factor.id} 没有任何分档。`);
    const labels = new Set<string>();
    for (const band of factor.bands) {
      if (!(band.min >= 0 && band.min <= 1)) say(`因子 ${factor.id} 的分档阈值必须在 0–1 之间。`);
      if (!band.label.trim()) say(`因子 ${factor.id} 的分档缺少 label。`);
      if (labels.has(band.label)) say(`因子 ${factor.id} 的分档标签重复：${band.label}`);
      labels.add(band.label);
    }
  }

  // 未被任何争点认领的要件
  for (const element of knowledge.elements) if (!claimedElements.has(element.id)) say(`要件 ${element.id} 未被任何争点引用。`);

  if (!issueIds.has(knowledge.fallbackIssueId)) say(`兜底争点不存在：${knowledge.fallbackIssueId}`);
  for (const rule of knowledge.routing ?? []) {
    if (!issueIds.has(rule.issueId)) say(`路由规则引用了不存在的争点：${rule.issueId}`);
    if (rule.keywords.length === 0) say(`争点 ${rule.issueId} 的路由关键词为空。`);
  }

  return problems;
}

/** 断言式入口：知识包不合格时直接抛错，避免带病装配。 */
export function assertKnowledge(knowledge: DomainKnowledge): DomainKnowledge {
  const problems = validateKnowledge(knowledge);
  if (problems.length > 0) throw new Error(`知识包校验未通过（${problems.length} 项）：\n- ${problems.join('\n- ')}`);
  return knowledge;
}

export const isMaterialKind = (value: string): value is MaterialKind => (MATERIAL_KINDS as readonly string[]).includes(value);
export const isRecordField = (value: string): value is RecordField => (RECORD_FIELDS as readonly string[]).includes(value);
