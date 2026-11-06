/** Public seam for domain plugins. Implementation files remain private to the foundation. */
export const LEGAL_PLUGIN_API_VERSION = 1;
export type { LegalAgentExtension } from './agent/engine.ts';
export type { AgentTool, AgentToolContext, PluginServices } from './agent-tools/contracts.ts';
export { AgentToolError, defineAgentTool } from './agent-tools/contracts.ts';
export type { InformationProfile } from './agent/profiles.ts';
export type { NeedSpec, StructuredNeed, InformationAnalysis } from './information/contracts.ts';
export type { JsonModel } from './information/model.ts';
export type { ProfessionalReviewer, ProfessionalReview, ProfessionalReviewInput } from './information/professional.ts';
export type { LoopRun, LoopFinding, LoopSource } from './loops/contracts.ts';
export { LoopRunStore } from './loops/store.ts';
export type { OutputSection } from './outputs/contracts.ts';
export type { NodeReviewKind, NodeReview, NodePreparation, NodeReviewContributionInput, NodeReviewContributor } from './node-review/contracts.ts';
