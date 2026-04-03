/**
 * @koi/resolve — Manifest auto-resolution layer (L0u)
 *
 * Bridges declarative koi.yaml configuration to runtime instances
 * via a registry of BrickDescriptors. Phase 1 covers:
 * middleware, soul, permissions, and model resolution.
 */

// descriptor validation
export {
  validateOptionalDescriptorOptions,
  validateRequiredDescriptorOptions,
} from "./descriptor-validation.js";
// discovery
export { discoverDescriptors } from "./discover.js";
export type { DescriptorManifest, ManifestEntry } from "./discover-static.js";
export { discoverDescriptorsAuto, discoverDescriptorsFromManifest } from "./discover-static.js";
// errors
export { aggregateErrors, formatResolutionError } from "./errors.js";
export type { BundledAgentRegistrationResult } from "./register-bundled-agents.js";
// bundled agent registration
export { registerBundledAgents } from "./register-bundled-agents.js";
export type { CompanionSkillRegistrationResult } from "./register-companion-skills.js";
// companion skill registration
export { registerCompanionSkills } from "./register-companion-skills.js";
// registry
export { createRegistry } from "./registry.js";

// resolvers
export { resolveChannels } from "./resolve-channels.js";
export { resolveEngine } from "./resolve-engine.js";
export { resolveManifest } from "./resolve-manifest.js";
export { resolveMiddleware } from "./resolve-middleware.js";
export { parseModelName, resolveModel } from "./resolve-model.js";
export { resolveOne } from "./resolve-one.js";
export { resolvePermissions } from "./resolve-permissions.js";
export { resolveSearch } from "./resolve-search.js";
export { resolveSoul } from "./resolve-soul.js";
// types
export type {
  BrickDescriptor,
  BrickFactory,
  MiddlewareResolutionResult,
  OptionsValidator,
  ResolutionContext,
  ResolutionFailure,
  ResolveApprovalHandler,
  ResolvedManifest,
  ResolveKind,
  ResolveRegistry,
} from "./types.js";
