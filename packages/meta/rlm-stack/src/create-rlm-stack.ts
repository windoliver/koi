/**
 * Factory — wires `@koi/middleware-rlm` with thresholds derived from the
 * configured context window and the requested tier preset.
 *
 * Composition only — no new processing algorithms (per issue #1359 scope).
 */

import { createRlmMiddleware, type RlmConfig } from "@koi/middleware-rlm";
import {
  CHUNK_CHARS_BY_TIER,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  type RlmStack,
  type RlmStackConfig,
  type RlmStackThresholds,
  type RlmStackTier,
} from "./types.js";

const KNOWN_TIERS: ReadonlySet<RlmStackTier> = new Set(["light", "standard", "aggressive"]);

function resolveTier(tier: RlmStackTier | undefined): RlmStackTier {
  if (tier === undefined) return "standard";
  if (!KNOWN_TIERS.has(tier)) {
    throw new Error(
      `@koi/rlm-stack: unknown tier "${String(tier)}" — expected one of light, standard, aggressive`,
    );
  }
  return tier;
}

function resolveContextWindow(config: RlmStackConfig | undefined): number {
  const requested = config?.contextWindowTokens;
  if (requested === undefined) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(
      `@koi/rlm-stack: contextWindowTokens must be a positive finite number (got ${String(requested)})`,
    );
  }
  return requested;
}

function buildThresholds(contextWindowTokens: number, tier: RlmStackTier): RlmStackThresholds {
  return {
    contextWindowTokens,
    maxInputTokens: contextWindowTokens,
    maxChunkChars: CHUNK_CHARS_BY_TIER[tier],
  };
}

function buildRlmConfig(
  config: RlmStackConfig | undefined,
  thresholds: RlmStackThresholds,
): RlmConfig {
  const out: Record<string, unknown> = {
    maxInputTokens: thresholds.maxInputTokens,
    maxChunkChars: thresholds.maxChunkChars,
  };
  if (config?.priority !== undefined) out.priority = config.priority;
  if (config?.acknowledgeSegmentLocalContract !== undefined) {
    out.acknowledgeSegmentLocalContract = config.acknowledgeSegmentLocalContract;
  }
  if (config?.trustMetadataRole !== undefined) out.trustMetadataRole = config.trustMetadataRole;
  if (config?.segmentSeparator !== undefined) out.segmentSeparator = config.segmentSeparator;
  if (config?.estimator !== undefined) out.estimator = config.estimator;
  if (config?.onEvent !== undefined) out.onEvent = config.onEvent;
  return out as RlmConfig;
}

export function createRlmStack(config?: RlmStackConfig): RlmStack {
  const tier = resolveTier(config?.tier);
  const contextWindowTokens = resolveContextWindow(config);
  const thresholds = buildThresholds(contextWindowTokens, tier);
  const middleware = createRlmMiddleware(buildRlmConfig(config, thresholds));
  return {
    middleware,
    thresholds,
    tier,
    sandboxExecutor: config?.sandboxExecutor,
  };
}
