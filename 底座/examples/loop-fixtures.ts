import { defineCapability, type PluginDefinition } from '../src/contracts.ts';
import {
  loopDeclarationInputSchema, loopDeclarationSchema, loopReadingInputSchema, loopReadingSchema,
  loopReviewInputSchema, loopReviewSchema, type LoopDocument,
} from '../src/loops/contracts.ts';

export const EXAMPLE_LOOP_REFS = Object.freeze({
  declare: { id: 'example.intake-needs', version: 1 },
  read: { id: 'example.read-intake', version: 1 },
  review: { id: 'example.review-intake', version: 1 },
});
export const EXAMPLE_LOOP_TEXTS = Object.freeze({
  notice: { sourceLabel: '虚构初次陈述', text: '上周主管口头说让我别来了。' },
  followUp: { sourceLabel: '虚构补充陈述', text: '此后公司没有再联系我安排工作。' },
});
const NEED_ID = 'example.stopped-attending';
const NOTICE = '读取初次陈述中的停止到岗原话，保留说话人和相对时间。';
const FOLLOW_UP = '读取补充陈述中的后续工作安排说法，保留否定表达。';
const TOGETHER = '一并读取初次陈述与补充陈述中的停止到岗和后续安排说法。';
const source = (document: LoopDocument) => ({
  materialId: document.materialId, versionId: document.versionId, textSha256: document.textSha256,
});

/**
 * Deterministic fixtures for testing coordination, not language understanding or
 * legal advice. The reader deliberately knows these two fictional fixture texts.
 * A real reader can replace this capability while retaining the same contract.
 */
export function createLoopExamplePlugins(
  strategy: 'follow-up' | 'read-together' = 'follow-up',
): PluginDefinition[] {
  const revision = strategy === 'follow-up' ? '1.0.0-follow-up-test' : '1.0.0-together-test';
  return [{
    manifest: { id: 'example.intake-professional-test', version: revision, apiVersion: 1 },
    capabilities: [
      defineCapability({
        ...EXAMPLE_LOOP_REFS.declare, input: loopDeclarationInputSchema, output: loopDeclarationSchema,
        execute: async () => ({ status: 'success', data: {
          needs: [{ id: NEED_ID, question: '材料如何记载停止到岗及之后的工作安排？',
            reason: '先保留已提供的停止到岗陈述，再核对后续安排，供承办人检查。' }],
          requests: [{ needId: NEED_ID, instruction: strategy === 'follow-up' ? NOTICE : TOGETHER,
            reason: '读取已有材料中的具体说法，并附上原文出处。' }],
        } }),
      }),
      defineCapability({
        ...EXAMPLE_LOOP_REFS.review, input: loopReviewInputSchema, output: loopReviewSchema,
        execute: async ({ findings, attempts }) => {
          const notice = findings.find((finding) => finding.needId === NEED_ID
            && finding.citations.some((citation) => citation.quote === EXAMPLE_LOOP_TEXTS.notice.text));
          const followUp = findings.find((finding) => finding.needId === NEED_ID
            && finding.citations.some((citation) => citation.quote === EXAMPLE_LOOP_TEXTS.followUp.text));
          if (notice && followUp) return { status: 'success', data: {
            assessments: [{ needId: NEED_ID, status: 'satisfied' as const, findingIds: [notice.id, followUp.id],
              reason: '已找到停止到岗原话及后续安排陈述，供人工核对；不据此认定法律结论。' }],
            nextRequests: [],
          } };
          const checkedFollowUp = attempts.some((attempt) => attempt.request.instruction === FOLLOW_UP
            || attempt.request.instruction === TOGETHER);
          if (notice && !checkedFollowUp) return { status: 'success', data: {
            assessments: [{ needId: NEED_ID, status: 'unresolved' as const, findingIds: [notice.id],
              reason: '口头通知原话已经提供；仍需检查材料有没有记载此后的工作安排。' }],
            nextRequests: [{ needId: NEED_ID, instruction: FOLLOW_UP,
              reason: '补查通知之后的安排，沿用已找到的通知陈述，避免重复询问。' }],
          } };
          return { status: 'success', data: {
            assessments: [{ needId: NEED_ID, status: 'unresolved' as const,
              findingIds: findings.filter((finding) => finding.needId === NEED_ID).map((finding) => finding.id),
              reason: '本测试读取范围内尚未取得所需的完整陈述，保留给人工核对。' }],
            nextRequests: [],
          } };
        },
      }),
    ],
  }, {
    manifest: { id: 'example.intake-reader-test', version: '1.0.0-test', apiVersion: 1 },
    capabilities: [defineCapability({
      ...EXAMPLE_LOOP_REFS.read, input: loopReadingInputSchema, output: loopReadingSchema,
      execute: async ({ request, documents }) => {
        const targets = request.instruction === NOTICE ? [EXAMPLE_LOOP_TEXTS.notice]
          : request.instruction === FOLLOW_UP ? [EXAMPLE_LOOP_TEXTS.followUp]
          : request.instruction === TOGETHER ? Object.values(EXAMPLE_LOOP_TEXTS) : undefined;
        if (!targets) throw new Error('The deterministic example reader only supports its declared fixture instructions.');
        const examined = [];
        const candidates = [];
        for (const target of targets) {
          const document = documents.find((item) => item.sourceLabel === target.sourceLabel);
          if (!document) continue;
          examined.push(source(document));
          const start = document.text.indexOf(target.text);
          if (start < 0) continue;
          if (document.text.indexOf(target.text, start + 1) >= 0) {
            throw new Error('The fixture quote occurs more than once; select its exact occurrence before reading.');
          }
          candidates.push({ statement: `当事人陈述：“${target.text}”`, citations: [{
            ...source(document), start, end: start + target.text.length, quote: target.text,
          }] });
        }
        return { status: 'success', data: { examined, candidates,
          note: '确定性测试读取：只定位指定虚构材料中的固定原话，保留相对时间与否定，不作法律推断。' } };
      },
    })],
  }];
}
