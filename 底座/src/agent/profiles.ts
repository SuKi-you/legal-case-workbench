import { z } from 'zod';
import { structuredNeedSchema, entityBindingSchema, type StructuredNeed, type EntityBinding } from '../information/contracts.ts';

export const informationProfileSchema = z.strictObject({
  id: z.string().trim().min(1), version: z.string().trim().min(1), description: z.string().trim().min(1),
  readingMode: z.enum(['per_need', 'batch']).optional(),
  needs: z.array(structuredNeedSchema).min(1), bindings: z.array(entityBindingSchema).optional(),
});
export interface InformationProfile { id: string; version: string; description: string; readingMode?: 'per_need' | 'batch' | undefined; needs: StructuredNeed[]; bindings?: EntityBinding[] | undefined }

/** Generic intake only; legal importance, legal tests and legal conclusions belong to a domain plugin. */
export const COMMON_INFORMATION_PROFILE: InformationProfile = {
  id: 'common.material-intake', version: '1.0.0', description: '整理材料明确记载的行为、讲话与交易，不作法律定性。',
  needs: [{ id: 'common.events', question: '材料明确记载了哪些具体行为、讲话或交易？逐项保留实施者、对象、陈述者、发生时间和实际内容。',
    reason: '形成可核对的事件与材料索引，保留否定、期间、口径和未知项。',
    spec: { topic: 'general.event', subject: null, object: null, period: null, basis: null,
      requiredFields: [], minimumSupport: 'statement', applicable: true } }],
};
