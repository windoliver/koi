/**
 * @koi/forge-policy — Forge governance, usage tracking, drift detection,
 * and re-verification policies (Layer 2).
 *
 * Depends on @koi/core, @koi/forge-types, @koi/git-utils, @koi/validation only.
 */

// drift checker — source file staleness detection
export type { DriftChecker, DriftCheckerConfig, DriftCheckResult } from "./drift-checker.js";
export { createDriftChecker } from "./drift-checker.js";
// forge governance contributor — ECS component for governance variables
export {
  createForgeGovernanceContributor,
  FORGE_GOVERNANCE,
} from "./forge-governance-contributor.js";
// forge session counter — engine-owned budget counter
export type {
  ForgeSessionCounterInstance,
  ForgeSessionCounterOptions,
} from "./forge-session-counter.js";
export { createForgeSessionCounter } from "./forge-session-counter.js";
// forge usage middleware — KoiMiddleware for usage tracking
export type { ForgeUsageMiddlewareConfig } from "./forge-usage-middleware.js";
export { createForgeUsageMiddleware } from "./forge-usage-middleware.js";
// governance — depth-aware policies, scope promotion, trust transitions
export type { GovernanceResult } from "./governance.js";
export {
  checkGovernance,
  checkScopePromotion,
  validatePolicyChange,
} from "./governance.js";
// mutation pressure — capability space protection
export type { MutationPressureResult } from "./mutation-pressure-check.js";
export { checkMutationPressure } from "./mutation-pressure-check.js";
// reverification queue — bounded concurrency re-verification
export type { ReverificationHandler, ReverificationQueue } from "./reverification-queue.js";
export { createReverificationQueue } from "./reverification-queue.js";
// usage — brick usage tracking
export type {
  UsageRecordedResult,
  UsageResult,
  UsageSignal,
} from "./usage.js";
export { recordBrickUsage } from "./usage.js";
