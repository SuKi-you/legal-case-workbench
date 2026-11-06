/** 仅通过底座公开的插件 API 接入；法域知识与判定不依赖底座内部实现。 */
export type { LegalAgentExtension, AgentTool, AgentToolContext, InformationProfile,
  NeedSpec, StructuredNeed, JsonModel, LoopRun, OutputSection,
  ProfessionalReviewer, ProfessionalReview, ProfessionalReviewInput,
  NodePreparation, NodeReviewContributor, LoopSource } from '../../底座/src/plugin-api.ts';
export { AgentToolError, defineAgentTool, LoopRunStore } from '../../底座/src/plugin-api.ts';
