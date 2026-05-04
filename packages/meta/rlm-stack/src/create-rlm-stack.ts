/**
 * Factory — wires `@koi/middleware-rlm` with thresholds derived from the
 * configured context window and the requested tier preset.
 *
 * Composition only — no new processing algorithms (per issue #1359 scope).
 */

import { resolveThresholds } from "@koi/context-manager";
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

/**
 * Resolve the effective context window using `@koi/context-manager`'s
 * `resolveThresholds` so RLM and context-manager agree byte-for-byte on the
 * window size for a given `(modelId, modelWindowOverrides, contextWindowTokens)`
 * triple. The resolver applies its own precedence (overrides → registry →
 * `contextWindowSize` → default) — `@koi/rlm-stack` does not second-guess it.
 *
 * `contextWindowTokens` is fed in as `contextWindowSize`, which is the same
 * field the rest of the system uses for explicit overrides.
 */
function resolveContextWindow(config: RlmStackConfig | undefined): number {
  const explicit = config?.contextWindowTokens;
  if (explicit !== undefined && (!Number.isFinite(explicit) || explicit <= 0)) {
    throw new Error(
      `@koi/rlm-stack: contextWindowTokens must be a positive finite number (got ${String(explicit)})`,
    );
  }
  const policy = resolveThresholds(
    {
      ...(config?.modelId !== undefined ? { modelId: config.modelId } : {}),
      ...(config?.modelWindowOverrides !== undefined
        ? { modelWindowOverrides: config.modelWindowOverrides }
        : {}),
      ...(explicit !== undefined ? { contextWindowSize: explicit } : {}),
    },
    config?.modelId,
  );
  const resolved = policy.contextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(
      `@koi/rlm-stack: resolved contextWindow is not a positive finite number (got ${String(resolved)}). ` +
        `Check modelWindowOverrides for invalid values.`,
    );
  }
  return resolved;
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
