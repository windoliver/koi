/**
 * @koi/resolve — Manifest auto-resolution layer (L0u)
 *
 * Bridges declarative koi.yaml configuration to runtime instances
 * via a registry of BrickDescriptors. Phase 1 covers:
 * middleware, soul, permissions, and model resolution.
 */

// discovery
export { discoverDescriptors } from "./discover.js";
// errors
export { aggregateErrors, formatResolutionError } from "./errors.js";
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
export { resolveSoul } from "./resolve-soul.js";
// types
export type {
  BrickDescriptor,
  BrickFactory,
  OptionsValidator,
  ResolutionContext,
  ResolutionFailure,
  ResolveApprovalHandler,
  ResolvedManifest,
  ResolveKind,
  ResolveRegistry,
} from "./types.js";
