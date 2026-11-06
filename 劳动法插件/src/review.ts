/** 专业复核：解释材料对条件的支持情况；通用覆盖率由底座独立保存。 */
import type { ProfessionalReviewer, ProfessionalReview } from './base.ts';
import { assessRun } from './kernel/assess.ts';
import type { DomainKnowledge } from './kernel/contracts.ts';

export function createProfessionalReviewer(knowledge: DomainKnowledge, profileId = 'labor.intake'): ProfessionalReviewer {
  return {
    id: `${knowledge.id}.review`, version: knowledge.version, profileId,
    review(input): ProfessionalReview {
      const result = assessRun(knowledge, { id: 'professional-review', goal: input.goal, status: 'needs_review',
        sources: input.sources, findings: input.findings, information: input.analysis });
      const activeIssues = new Set(result.route.map((item) => item.issueId));
      const knownTerminationOrigin = result.elements.some((item) => ['labor.termination.by-employer', 'labor.termination.by-employee', 'labor.termination.by-agreement'].includes(item.elementId)
        && ['satisfied', 'statement_only'].includes(item.state));
      const scoped = result.elements.filter(item => activeIssues.size === 0 || activeIssues.has(item.issueId));
      const focused = scoped.filter((item) => {
        if (item.kind === 'evaluative' && item.findingIds.length === 0) return false;
        if (item.elementId === 'labor.double.exclusion' && item.findingIds.length === 0) return false;
        if (knownTerminationOrigin && ['labor.termination.by-employer', 'labor.termination.by-employee', 'labor.termination.by-agreement'].includes(item.elementId)
          && item.findingIds.length === 0) return false;
        return true;
      });
      // Routing is a priority hint. A source with no matches must still reach
      // the remaining declared reads and keep its unresolved checks visible.
      const elements = focused.length > 0 ? focused : scoped.length > 0 ? scoped : result.elements;
      const assessments: ProfessionalReview['assessments'] = elements.map((element) => ({
        checkId: element.elementId,
        state: element.state === 'opposed' ? 'opposed' : element.state === 'conflicting' ? 'conflicting'
          : element.state === 'not_applicable' ? 'not_applicable'
          : ['satisfied', 'statement_only'].includes(element.state) && element.kind !== 'evaluative' ? 'supported' : 'unresolved',
        findingIds: [...element.findingIds],
        reason: element.scopeNote ?? (element.state === 'opposed' ? '已保留明确反向记录，不能用它满足正向条件。'
          : element.state === 'needs_review' ? '资料的字段、含义或覆盖范围仍有待核对，暂不升级为专业条件满足。'
          : element.kind === 'evaluative' ? '此项需要综合评价，模型参考意见不能改写专业条件状态。'
          : `「${element.title}」的材料支持状态为 ${element.state}；仅指材料记载，不表示司法认定。`),
      }));
      const actions: ProfessionalReview['actions'] = [];
      for (const element of elements) {
        if (!['unread', 'absent', 'needs_review', 'conflicting'].includes(element.state)) continue;
        for (const needId of element.needIds) {
          const coverage = input.analysis.needs.find((item) => item.needId === needId);
          const need = input.needs.find((item) => item.id === needId);
          if (!coverage || !need) continue;
          if (coverage.unread.length > 0) {
            actions.push({ kind: 'read', checkId: element.elementId, needId, sources: [coverage.unread[0]!],
              reason: `专业检查仍需核对「${element.title}」，尚有本需求未读取的材料。`,
              instruction: `围绕「${need.question}」补查剩余来源，保留已有回答及肯否，不重复索取已给出的内容。` });
          } else if (element.state === 'conflicting' || coverage.satisfaction === 'needs_review') {
            actions.push({ kind: 'human_review', checkId: element.elementId, needId,
              reason: '来源已检查完毕，存在语义待核或矛盾，不能以缺材料替代事实取舍。', instruction: `核对「${element.title}」的双方记载及其来源，保留分歧。` });
          } else if (coverage.nextActions.some((item) => item.kind === 'clarify')) {
            actions.push({ kind: 'clarify', checkId: element.elementId, needId,
              reason: '当前选定材料已核对，必要字段仍缺失；已有原话与事实继续沿用。',
              instruction: coverage.nextActions.find((item) => item.kind === 'clarify')!.instruction });
          }
        }
      }
      // Evaluative opinions and candidate defenses are separate from factual coverage.
      for (const element of elements.filter((item) => item.kind === 'evaluative' && item.findingIds.length > 0)) {
        const needId = element.needIds[0]; if (needId) actions.push({ kind: 'human_review', checkId: element.elementId, needId,
          reason: '评价性条件需专业判断，意见不得直接阻断路径。', instruction: `综合核对「${element.title}」及其支持、反对因素。` });
      }
      // Every unresolved professional check must remain visibly pending even if the base did not propose a question.
      for (const assessment of assessments.filter((item) => ['unresolved', 'conflicting'].includes(item.state))) {
        if (actions.some((item) => item.checkId === assessment.checkId)) continue;
        const needId = elements.find((item) => item.elementId === assessment.checkId)?.needIds[0];
        if (needId) actions.push({ kind: 'human_review', checkId: assessment.checkId, needId,
          reason: '专业条件仍待核对，不能以没有新读取动作伪装完成。', instruction: assessment.reason });
      }
      const byQuestion = new Map<string, ProfessionalReview['actions'][number]>();
      for (const action of actions) {
        const key = JSON.stringify([action.kind, action.needId, action.sources ?? []]);
        const existing = byQuestion.get(key);
        if (!existing) byQuestion.set(key, action);
        else if (existing.checkId !== action.checkId) existing.reason += ` 同一信息也用于核对「${action.checkId}」。`;
      }
      const uniqueActions = [...byQuestion.values()];
      return { assessments, actions: uniqueActions,
        decision: uniqueActions.some((item) => item.kind === 'read') ? 'continue'
          : uniqueActions.some((item) => item.kind === 'human_review') ? 'human_review'
          : uniqueActions.some((item) => item.kind === 'clarify') ? 'needs_input' : 'ready' };
    },
  };
}
