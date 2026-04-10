/**
 * Model router configuration types and Zod validation.
 *
 * Phase 2: fallback, round-robin, weighted strategies only.
 * Cascade strategy is Phase 3.
 */

import type { KoiError, Result } from "@koi/core";
import type { CircuitBreakerConfig, CircuitBreakerSnapshot, RetryConfig } from "@koi/errors";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG, DEFAULT_RETRY_CONFIG } from "@koi/errors";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import type { ProviderAdapterConfig } from "./provider-adapter.js";

export type RoutingStrategy = "fallback" | "round-robin" | "weighted";

export interface ModelCapabilitiesPartial {
  readonly streaming?: boolean | undefined;
  readonly functionCalling?: boolean | undefined;
  readonly vision?: boolean | undefined;
  readonly jsonMode?: boolean | undefined;
  readonly maxContextTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
}

export interface ModelTargetConfig {
  readonly provider: string;
  readonly model: string;
  readonly weight?: number | undefined;
  readonly enabled?: boolean | undefined;
  readonly adapterConfig: ProviderAdapterConfig;
  readonly capabilities?: ModelCapabilitiesPartial | undefined;
  readonly costPerInputToken?: number | undefined;
  readonly costPerOutputToken?: number | undefined;
}

/** Health probe — active pinging for local providers only. Remote providers use CB passively. */
export interface HealthProbeConfig {
  readonly intervalMs?: number | undefined;
}

export interface ModelRouterConfig {
  readonly targets: readonly ModelTargetConfig[];
  readonly strategy: RoutingStrategy;
  readonly retry?: Partial<RetryConfig> | undefined;
  readonly circuitBreaker?: Partial<CircuitBreakerConfig> | undefined;
  readonly healthProbe?: HealthProbeConfig | undefined;
}

// ---------------------------------------------------------------------------
// Resolved (defaults applied)
// ---------------------------------------------------------------------------

export interface ResolvedTargetConfig {
  readonly provider: string;
  readonly model: string;
  readonly weight: number;
  readonly enabled: boolean;
  readonly adapterConfig: ProviderAdapterConfig;
  readonly capabilities?: ModelCapabilitiesPartial | undefined;
  readonly costPerInputToken?: number | undefined;
  readonly costPerOutputToken?: number | undefined;
}

export interface ResolvedRouterConfig {
  readonly targets: readonly ResolvedTargetConfig[];
  readonly strategy: RoutingStrategy;
  readonly retry: RetryConfig;
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly healthProbe?: HealthProbeConfig | undefined;
}

// ---------------------------------------------------------------------------
// Metrics types (returned by router.getMetrics())
// ---------------------------------------------------------------------------

/** Per-target health and performance metrics. */
export interface TargetMetrics {
  readonly requests: number;
  readonly failures: number;
  /** p50 latency in ms. Undefined until at least 2 samples are recorded. */
  readonly p50Ms: number | undefined;
  /** p95 latency in ms. Undefined until at least 2 samples are recorded. */
  readonly p95Ms: number | undefined;
  readonly lastErrorAt: number | undefined;
}

export interface RouterMetrics {
  readonly totalRequests: number;
  readonly totalFailures: number;
  /** Per-target metrics keyed by "provider:model" */
  readonly byTarget: ReadonlyMap<string, TargetMetrics>;
  readonly totalEstimatedCost: number;
}

export type { CircuitBreakerSnapshot };

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const adapterConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const capabilitiesSchema = z
  .object({
    streaming: z.boolean().optional(),
    functionCalling: z.boolean().optional(),
    vision: z.boolean().optional(),
    jsonMode: z.boolean().optional(),
    maxContextTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .optional();

const targetSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  weight: z.number().min(0).max(1).optional(),
  enabled: z.boolean().optional(),
  adapterConfig: adapterConfigSchema,
  capabilities: capabilitiesSchema,
  costPerInputToken: z.number().min(0).optional(),
  costPerOutputToken: z.number().min(0).optional(),
});

const retrySchema = z.object({
  maxRetries: z.number().int().min(0).max(10).optional(),
  backoffMultiplier: z.number().positive().optional(),
  initialDelayMs: z.number().int().positive().optional(),
  maxBackoffMs: z.number().int().positive().optional(),
  jitter: z.boolean().optional(),
});

const circuitBreakerSchema = z.object({
  failureThreshold: z.number().int().min(1).optional(),
  cooldownMs: z.number().int().min(1_000).optional(),
  failureWindowMs: z.number().int().min(1_000).optional(),
  failureStatusCodes: z.array(z.number().int()).optional(),
});

const healthProbeSchema = z
  .object({
    intervalMs: z.number().int().positive().optional(),
  })
  .optional();

const routerConfigSchema = z.object({
  targets: z.array(targetSchema).min(1),
  strategy: z.union([z.literal("fallback"), z.literal("round-robin"), z.literal("weighted")]),
  retry: retrySchema.optional(),
  circuitBreaker: circuitBreakerSchema.optional(),
  healthProbe: healthProbeSchema,
});

// ---------------------------------------------------------------------------
// Validation + resolution
// ---------------------------------------------------------------------------

/**
 * Validates and resolves raw router config with defaults applied.
 */
export function validateRouterConfig(raw: unknown): Result<ResolvedRouterConfig, KoiError> {
  const parsed = validateWith(routerConfigSchema, raw, "Model router config validation failed");
  if (!parsed.ok) return parsed;

  const config = parsed.value;

  const resolvedTargets: readonly ResolvedTargetConfig[] = config.targets.map((t) => ({
    provider: t.provider,
    model: t.model,
    weight: t.weight ?? 1,
    enabled: t.enabled ?? true,
    adapterConfig: {
      ...(t.adapterConfig.apiKey !== undefined ? { apiKey: t.adapterConfig.apiKey } : {}),
      ...(t.adapterConfig.baseUrl !== undefined ? { baseUrl: t.adapterConfig.baseUrl } : {}),
      ...(t.adapterConfig.timeoutMs !== undefined ? { timeoutMs: t.adapterConfig.timeoutMs } : {}),
      ...(t.adapterConfig.headers !== undefined ? { headers: t.adapterConfig.headers } : {}),
    },
    ...(t.capabilities !== undefined ? { capabilities: t.capabilities } : {}),
    ...(t.costPerInputToken !== undefined ? { costPerInputToken: t.costPerInputToken } : {}),
    ...(t.costPerOutputToken !== undefined ? { costPerOutputToken: t.costPerOutputToken } : {}),
  }));

  const resolvedRetry: RetryConfig = {
    maxRetries: config.retry?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
    backoffMultiplier: config.retry?.backoffMultiplier ?? DEFAULT_RETRY_CONFIG.backoffMultiplier,
    initialDelayMs: config.retry?.initialDelayMs ?? DEFAULT_RETRY_CONFIG.initialDelayMs,
    maxBackoffMs: config.retry?.maxBackoffMs ?? DEFAULT_RETRY_CONFIG.maxBackoffMs,
    jitter: config.retry?.jitter ?? DEFAULT_RETRY_CONFIG.jitter,
  };

  const resolvedCB: CircuitBreakerConfig = {
    failureThreshold:
      config.circuitBreaker?.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold,
    cooldownMs: config.circuitBreaker?.cooldownMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMs,
    failureWindowMs:
      config.circuitBreaker?.failureWindowMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.failureWindowMs,
    failureStatusCodes:
      config.circuitBreaker?.failureStatusCodes ??
      DEFAULT_CIRCUIT_BREAKER_CONFIG.failureStatusCodes,
  };

  return {
    ok: true,
    value: {
      targets: resolvedTargets,
      strategy: config.strategy,
      retry: resolvedRetry,
      circuitBreaker: resolvedCB,
      ...(config.healthProbe !== undefined ? { healthProbe: config.healthProbe } : {}),
    },
  };
}
