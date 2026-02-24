/**
 * @koi/model-router — Multi-provider LLM routing with failover (Layer 2)
 *
 * World Service that routes model calls across multiple LLM providers
 * with retry, fallback chains, cascade escalation, and circuit breaker resilience.
 *
 * Depends on @koi/core (for types) and @koi/validation (for config validation).
 */

export { createAnthropicAdapter } from "./adapters/anthropic.js";
// Auto-discovery
export {
  type DiscoveredProvider,
  type DiscoverOptions,
  discoverLocalProviders,
  type LocalProviderKind,
} from "./adapters/discover.js";
// Provider adapters
export { createLMStudioAdapter, type LMStudioAdapterConfig } from "./adapters/lm-studio.js";
export { createOllamaAdapter, type OllamaAdapterConfig } from "./adapters/ollama.js";
export { createOpenAIAdapter } from "./adapters/openai.js";
export {
  createOpenAICompatibleAdapter,
  type OpenAICompatibleConfig,
} from "./adapters/openai-compat.js";
export {
  createOpenRouterAdapter,
  type OpenRouterAdapterConfig,
} from "./adapters/openrouter.js";
// Shared adapter utilities
export {
  type FetchWithTimeoutOptions,
  type FetchWithTimeoutResult,
  fetchWithTimeout,
  handleAbortError,
  mapStatusToErrorCode,
  parseRetryAfter,
  parseSSEStream,
} from "./adapters/shared.js";
export { createVLLMAdapter, type VLLMAdapterConfig } from "./adapters/vllm.js";
export { createCascadeMetricsTracker } from "./cascade/cascade-metrics.js";
// Cascade
export type {
  CascadeAttempt,
  CascadeClassifier,
  CascadeConfig,
  CascadeCostMetrics,
  CascadeEvaluationResult,
  CascadeEvaluator,
  CascadeResult,
  CascadeTierConfig,
  ClassificationResult,
  ComplexityTier,
  ResolvedCascadeConfig,
  TierCostMetrics,
} from "./cascade/cascade-types.js";
export {
  type ComplexityClassifierOptions,
  createComplexityClassifier,
  type DimensionKey,
} from "./cascade/complexity-classifier.js";
export {
  type CompositionStrategy,
  composeEvaluators,
  createKeywordEvaluator,
  createLengthHeuristicEvaluator,
  createVerbalizedEvaluator,
  type KeywordEvaluatorOptions,
  type LengthHeuristicOptions,
  type VerbalizedEvaluatorOptions,
  type WeightedEvaluator,
} from "./cascade/evaluators.js";
// Resilience
export {
  type CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerSnapshot,
  type CircuitState,
  createCircuitBreaker,
} from "./circuit-breaker.js";
// Config
export type {
  HealthProbeConfig,
  ModelCapabilitiesPartial,
  ModelRouterConfig,
  ModelTargetConfig,
  ResolvedRouterConfig,
  RoutingStrategy,
} from "./config.js";
export {
  type FallbackAttempt,
  type FallbackResult,
  type FallbackTarget,
  withFallback,
} from "./fallback.js";
// Middleware
export { createModelRouterMiddleware } from "./middleware.js";

// Provider
export type { ProviderAdapter, ProviderAdapterConfig, StreamChunk } from "./provider-adapter.js";
export { calculateBackoff, type RetryConfig, withRetry } from "./retry.js";
// Router
export {
  createModelRouter,
  type ModelRouter,
  type ModelRouterOptions,
  type RouterMetrics,
} from "./router.js";
