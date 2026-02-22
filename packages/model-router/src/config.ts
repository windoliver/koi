/**
 * Model router configuration types and Zod validation.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import { type CircuitBreakerConfig, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./circuit-breaker.js";
import type { ProviderAdapterConfig } from "./provider-adapter.js";
import { DEFAULT_RETRY_CONFIG, type RetryConfig } from "./retry.js";

export type RoutingStrategy = "fallback" | "round-robin" | "weighted";

export interface ModelTargetConfig {
  readonly provider: string;
  readonly model: string;
  readonly weight?: number;
  readonly enabled?: boolean;
  readonly adapterConfig: ProviderAdapterConfig;
}

export interface ModelRouterConfig {
  readonly targets: readonly ModelTargetConfig[];
  readonly strategy: RoutingStrategy;
  readonly retry?: Partial<RetryConfig>;
  readonly circuitBreaker?: Partial<CircuitBreakerConfig>;
}

export interface ResolvedRouterConfig {
  readonly targets: readonly ResolvedTargetConfig[];
  readonly strategy: RoutingStrategy;
  readonly retry: RetryConfig;
  readonly circuitBreaker: CircuitBreakerConfig;
}

export interface ResolvedTargetConfig {
  readonly provider: string;
  readonly model: string;
  readonly weight: number;
  readonly enabled: boolean;
  readonly adapterConfig: ProviderAdapterConfig;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const adapterConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const targetSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  weight: z.number().min(0).max(1).optional(),
  enabled: z.boolean().optional(),
  adapterConfig: adapterConfigSchema,
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

const routerConfigSchema = z.object({
  targets: z.array(targetSchema).min(1),
  strategy: z.union([z.literal("fallback"), z.literal("round-robin"), z.literal("weighted")]),
  retry: retrySchema.optional(),
  circuitBreaker: circuitBreakerSchema.optional(),
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
      apiKey: t.adapterConfig.apiKey,
      baseUrl: t.adapterConfig.baseUrl,
      timeoutMs: t.adapterConfig.timeoutMs,
      headers: t.adapterConfig.headers,
    },
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
    },
  };
}
