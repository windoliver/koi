/**
 * @koi/middleware-tool-selector — Pre-filter tools before model calls (Layer 2)
 *
 * Uses a caller-provided selector function or named profile to reduce the set
 * of tools sent to the model, saving tokens and improving selection accuracy.
 * Depends on @koi/core only.
 */

export type { ToolSelectorConfig, ValidatedToolSelectorConfig } from "./config.js";
export { validateToolSelectorConfig } from "./config.js";
export { createTagSelectTools, descriptor } from "./descriptor.js";
export { extractLastUserText } from "./extract-query.js";
export type { CapabilityTier } from "./model-tier.js";
export { detectModelTier, MODEL_CAPABILITY_TIERS } from "./model-tier.js";
export type { ProfileResolutionInput, ResolvedProfile } from "./resolve-profile.js";
export { resolveProfile } from "./resolve-profile.js";
export type { ToolProfileName } from "./tool-profiles.js";
export { isToolProfileName, TOOL_PROFILES } from "./tool-profiles.js";
export { createToolSelectorMiddleware } from "./tool-selector.js";
