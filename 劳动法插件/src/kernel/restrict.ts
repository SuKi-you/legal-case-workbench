/**
 * 通用结构层 · 知识包裁剪
 *
 * 用途：只装配部分争点时，把知识包裁到自洽的最小集合。
 * 裁剪原则：
 * - 争点、要件、路径、因子、校验只保留被选中的部分；
 * - 抗辩：针对选中争点且成立条件仍完整时才保留，不能删条件改变含义；
 * - 分流与路由：丢弃指向已裁掉争点的条目；
 * - 法源保留原样（多余的法源无害，缺法源会由体检报错）。
 *
 * 裁剪后必须能通过 validateKnowledge，否则说明知识包本身依赖跨争点结构。
 */
import type { DomainKnowledge } from './contracts.ts';

export function restrictKnowledge(knowledge: DomainKnowledge, issueIds: readonly string[]): DomainKnowledge {
  const selected = new Set(issueIds);
  const issues = knowledge.issues.filter((issue) => selected.has(issue.id));
  const elements = knowledge.elements.filter((element) => selected.has(element.issueId));
  const elementIds = new Set(elements.map((element) => element.id));
  const needIds = new Set(elements.flatMap((element) => element.needs));

  const defenses = knowledge.defenses === undefined ? undefined : knowledge.defenses
    .filter((defense) => defense.against.some((issueId) => selected.has(issueId))
      && defense.requires.every((expectation) => elementIds.has(expectation.elementId)))
    .map((defense) => ({
      ...defense,
      against: defense.against.filter((issueId) => selected.has(issueId)),
      requires: defense.requires.filter((expectation) => elementIds.has(expectation.elementId)),
    }));
  const defenseIds = new Set((defenses ?? []).map((defense) => defense.id));

  const factors = knowledge.factors === undefined ? undefined : knowledge.factors
    .filter((factor) => selected.has(factor.issueId))
    .map((factor) => ({ ...factor, parts: factor.parts.filter((part) => elementIds.has(part.elementId)) }))
    .filter((factor) => factor.parts.length > 0);

  const checks = knowledge.checks === undefined ? undefined : knowledge.checks
    .filter((check) => check.when.every((condition) => condition.elementId === undefined || elementIds.has(condition.elementId))
      && (check.claim === undefined || needIds.has(check.claim.needId))
      && (check.gap === undefined || elementIds.has(check.gap.elementId)));

  // 提问模板只保留要件仍在集合内的条目，否则裁剪后会指向不存在的要件。
  const opinions = knowledge.opinions === undefined ? undefined : knowledge.opinions
    .filter((opinion) => elementIds.has(opinion.elementId));

  const routing = knowledge.routing === undefined ? undefined : knowledge.routing
    .filter((rule) => selected.has(rule.issueId));

  const trimmedIssues = issues.map((issue) => ({
    ...issue,
    ...(issue.paths === undefined ? {} : {
      // 路径的成立条件里有被裁掉的要件时，整条路径丢弃——不能留下"无条件的路径"。
      paths: issue.paths
        .filter((path) => path.requires.every((expectation) => elementIds.has(expectation.elementId)))
        .map((path) => ({
          ...path,
          ...(path.blockedBy === undefined ? {} : { blockedBy: path.blockedBy.filter((id) => defenseIds.has(id)) }),
        })),
    }),
  }));

  const fallback = selected.has(knowledge.fallbackIssueId)
    ? knowledge.fallbackIssueId
    : (trimmedIssues[0]?.id ?? knowledge.fallbackIssueId);

  return {
    ...knowledge,
    issues: trimmedIssues,
    elements,
    ...(defenses === undefined ? {} : { defenses }),
    ...(factors === undefined ? {} : { factors }),
    ...(checks === undefined ? {} : { checks }),
    ...(opinions === undefined ? {} : { opinions }),
    ...(routing === undefined ? {} : { routing }),
    fallbackIssueId: fallback,
  };
}

/** 裁剪后仍无争点，说明调用方给的 id 全都不存在。 */
export const isEmptySelection = (knowledge: DomainKnowledge): boolean => knowledge.issues.length === 0;
