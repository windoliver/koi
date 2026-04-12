/**
 * @koi/model-router — Multi-provider LLM routing with fallback and health monitoring (L2)
 *
 * Phase 2: ordered fallback chains, per-target circuit breakers, latency tracking,
 * in-flight dedup, local health probing, streaming-safe failover.
 *
 * Phase 3 (future): cascade strategy, BrickDescriptor, concrete adapter packages.
 */

// Config
export type {
  CircuitBreakerSnapshot,
  HealthProbeConfig,
  ModelCapabilitiesPartial,
  ModelRouterConfig,
  ModelTargetConfig,
  ResolvedRouterConfig,
  ResolvedTargetConfig,
  RouterMetrics,
  RoutingStrategy,
  TargetMetrics,
} from "./config.js";
export { validateRouterConfig } from "./config.js";

// Core primitives
export type {
  FallbackAttempt,
  FallbackResult,
  FallbackTarget,
} from "./fallback.js";
export { withFallback } from "./fallback.js";
export type { CreateHealthProbeOptions, HealthProbe, ProbeTarget } from "./health-probe.js";
export { createHealthProbe } from "./health-probe.js";
export type { InFlightCacheAsync } from "./in-flight-cache.js";
export { createInFlightCache } from "./in-flight-cache.js";
// New utilities
export type { LatencyPercentiles, LatencyTracker } from "./latency-tracker.js";
export { createLatencyTracker } from "./latency-tracker.js";
// Middleware
export { createModelRouterMiddleware } from "./middleware.js";
// Normalize utilities (for adapter implementors)
export type { NormalizedMessage, NormalizedRole } from "./normalize.js";
export { mapSenderIdToRole, normalizeMessages, normalizeToPlainText } from "./normalize.js";
// Provider interface
export type { ProviderAdapter, ProviderAdapterConfig } from "./provider-adapter.js";
// Router
export type { ModelRouter, ModelRouterOptions } from "./router.js";
export { createModelRouter } from "./router.js";
export type { TargetOrderer, TargetOrdererOptions } from "./target-ordering.js";
export { createTargetOrderer } from "./target-ordering.js";
