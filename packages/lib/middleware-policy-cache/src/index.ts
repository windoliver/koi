/**
 * @koi/middleware-policy-cache — Short-circuit tool calls for forge-verified
 * bricks promoted to policy mode.
 *
 * Runs at intercept@150 (before permissions). On a hit, the cached policy
 * executor decides allow/block deterministically without consulting the model.
 * register() rejects unverified entries; eviction is event-driven via an
 * optional StoreChangeNotifier.
 */

export type {
  PolicyCacheConfig,
  PolicyCacheHandle,
  PolicyDecision,
  PolicyEntry,
} from "./policy-cache.js";
export { createPolicyCacheMiddleware } from "./policy-cache.js";
