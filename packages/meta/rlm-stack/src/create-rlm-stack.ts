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
  RLM_STACK_PRIORITY_FLOOR,
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
 * BEFORE segmentation. The floor `RLM_STACK_PRIORITY_FLOOR` sits **strictly
 * above** the priority-`800` peers in the repo (notably
 * `@koi/middleware-tool-disclosure`, which pins itself at `800` and requires
 * being the innermost tool-list mutator). Equal numeric priorities have
 * undefined relative order in the engine sorter, so a `priority: 800`
 * configuration could let RLM segment before tool-disclosure observes the
 * advertised tool list. Pushing the floor by `+1` removes that ambiguity.
 *
 * **This is still a floor, not a proof.** It blocks the obvious mistakes
 * (lowered priority, equal-priority races with the known peers it covers).
 * It does NOT prove that RLM will run deeper than every tool-injecting
 * middleware in an arbitrary caller composition — a peer registered above
 * `RLM_STACK_PRIORITY_FLOOR` would still bypass the guard. Composers
 * stacking custom tool-injecting `wrapModelCall` middleware must verify
 * their relative ordering and bump RLM's priority above all such peers.
 */
function resolvePriority(priority: number | undefined): number {
  if (priority === undefined) return RLM_STACK_PRIORITY_FLOOR;
  if (!Number.isFinite(priority)) {
    throw new Error(`@koi/rlm-stack: priority must be a finite number (got ${String(priority)})`);
  }
  if (priority < RLM_STACK_PRIORITY_FLOOR) {
    throw new Error(
      `@koi/rlm-stack: priority ${priority} is below RLM_STACK_PRIORITY_FLOOR (${RLM_STACK_PRIORITY_FLOOR}); ` +
        `lowering below the floor would let RLM segment before known tool-injecting / tool-list-mutating ` +
        `middleware materializes request.tools, defeating its fail-closed guard. The floor sits strictly ` +
        `above @koi/middleware-tool-disclosure (priority 800) to break the equal-priority tie. This is a ` +
        `best-effort floor — composers stacking custom tool-injecting middleware above ` +
        `${RLM_STACK_PRIORITY_FLOOR} must additionally verify their relative ordering. Use ` +
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
  out.priority = resolvePriority(config?.priority);
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
