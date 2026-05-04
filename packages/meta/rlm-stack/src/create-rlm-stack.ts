/**
 * Factory — wires `@koi/middleware-rlm` with thresholds derived from the
 * configured context window and the requested tier preset.
 *
 * Composition only — no new processing algorithms (per issue #1359 scope).
 */

import { resolveThresholds } from "@koi/context-manager";
import { createRlmMiddleware, DEFAULT_PRIORITY, type RlmConfig } from "@koi/middleware-rlm";
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
 * Resolve the effective context window via `@koi/context-manager`'s
 * `resolveThresholds`. This is the single source of truth — `@koi/rlm-stack`
 * does not second-guess the resolver, so RLM and context-manager always agree
 * on the window for the same `(modelId, modelWindowOverrides, contextWindowTokens)`
 * triple.
 *
 * Caveat (tracked in a follow-up issue): `resolveThresholds` does not strip
 * provider prefixes from `modelId` and treats unknown ids as the registry
 * default (`128_000`) rather than letting `contextWindowTokens` take effect.
 * Until that resolver is generalized, callers using prefixed or private
 * model ids must supply `modelWindowOverrides` (matched to whatever form they
 * pass elsewhere) to control the window in BOTH layers in lock-step.
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

/**
 * Best-effort priority floor for `middleware-rlm`'s tool-safety guard.
 *
 * `middleware-rlm` requires that RLM run *deeper* in the intercept tier than
 * any tool-injecting `wrapModelCall` middleware so its
 * `request.tools.length > 0` fail-closed guard sees the synthetic tool list
 * BEFORE segmentation. The default priority `800` (`DEFAULT_PRIORITY`) sits
 * above the v1 tool-injectors known at the time this floor was added (e.g.
 * `tool-selector` at 200). Lowering below `DEFAULT_PRIORITY` is a clear
 * footgun: RLM would segment an oversized turn before known tool injectors
 * run, multiplying tool-capable calls per segment.
 *
 * **This check is a floor, not a proof.** It blocks the obvious mistake. It
 * does NOT prove that RLM will run deeper than every tool-injecting
 * middleware in the caller's actual composition — a peer middleware
 * registered at a priority > `DEFAULT_PRIORITY` would still bypass the guard.
 * Composers stacking custom tool-injecting `wrapModelCall` middleware must
 * verify their relative ordering and either bump RLM's priority above all
 * such peers or accept that the guard is best-effort for that stack.
 */
function resolvePriority(priority: number | undefined): number | undefined {
  if (priority === undefined) return undefined;
  if (!Number.isFinite(priority)) {
    throw new Error(`@koi/rlm-stack: priority must be a finite number (got ${String(priority)})`);
  }
  if (priority < DEFAULT_PRIORITY) {
    throw new Error(
      `@koi/rlm-stack: priority ${priority} is below DEFAULT_PRIORITY (${DEFAULT_PRIORITY}); ` +
        `lowering below the floor would let RLM segment before known tool-injecting ` +
        `middleware materializes request.tools, defeating its fail-closed guard. This is a ` +
        `best-effort floor — composers stacking custom tool-injecting middleware above ` +
        `${DEFAULT_PRIORITY} must additionally verify their relative ordering. Use ` +
        `createRlmMiddleware directly if you genuinely need a lower priority and accept ` +
        `the tool-fanout risk.`,
    );
  }
  return priority;
}

function buildRlmConfig(
  config: RlmStackConfig | undefined,
  thresholds: RlmStackThresholds,
): RlmConfig {
  const out: Record<string, unknown> = {
    maxInputTokens: thresholds.maxInputTokens,
    maxChunkChars: thresholds.maxChunkChars,
  };
  const priority = resolvePriority(config?.priority);
  if (priority !== undefined) out.priority = priority;
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
