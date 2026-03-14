/**
 * @koi/middleware-policy-cache — Policy-mode middleware cache (L2).
 *
 * Short-circuits model calls for harness-synthesized middleware that
 * has reached 100% success rate (promoted by forge-optimizer).
 * Event-driven invalidation via StoreChangeNotifier.
 */

export {
  createPolicyCacheMiddleware,
  type PolicyCacheConfig,
  type PolicyCacheHandle,
  type PolicyDecision,
  type PolicyEntry,
} from "./policy-cache.js";
