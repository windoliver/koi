/**
 * ForgeResolver — Resolver adapter backed by a ForgeStore.
 * Implements the L0 Resolver<BrickArtifact, BrickArtifact> interface.
 */

import type {
  BrickArtifact,
  BrickDriftContext,
  ForgeStore,
  KoiError,
  Resolver,
  Result,
  SourceBundle,
  ToolPolicy,
} from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import type { DriftChecker } from "@koi/forge-types";
import { filterByAgentScope, isVisibleToAgent } from "@koi/forge-types";
import { evaluateTrustDecay } from "@koi/validation";

// ---------------------------------------------------------------------------
// Source extraction — pure function, exhaustive over BrickArtifact union
// ---------------------------------------------------------------------------

export function extractSource(brick: BrickArtifact): SourceBundle {
  const files = brick.files !== undefined ? { files: brick.files } : {};
  switch (brick.kind) {
    case "tool":
    case "middleware":
    case "channel":
      return { content: brick.implementation, language: "typescript", ...files };
    case "skill":
      return { content: brick.content, language: "markdown", ...files };
    case "agent":
      return { content: brick.manifestYaml, language: "yaml", ...files };
    case "composite":
      return {
        content: brick.steps.map((s) => s.brickId).join(","),
        language: "typescript",
        ...files,
      };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Maximum number of async demotion updates per discover() call. */
const MAX_DECAY_DEMOTIONS_PER_DISCOVER = 5;

export interface ForgeResolverContext {
  readonly agentId: string;
  /** Called when a brick is demoted due to fitness decay. */
  readonly onDecayDemotion?: (brickId: string, from: ToolPolicy, to: ToolPolicy) => void;
  /** Called when a decay-related store update or callback throws. */
  readonly onError?: (error: unknown) => void;
  /** Called when discover() returns zero visible bricks. */
  readonly onDiscoveryMiss?: () => void;
  /** Injected drift checker for source-file staleness detection on load(). */
  readonly driftChecker?: DriftChecker;
}

/**
 * Returns NOT_FOUND if the brick exists but is not visible to the caller.
 * This avoids leaking brick existence to unauthorized agents.
 */
function notFoundError(id: string): Result<never, KoiError> {
  return {
    ok: false,
    error: { code: "NOT_FOUND", message: `Brick not found: ${id}`, retryable: false },
  };
}

/**
 * Fires an async store.update() to demote a brick, capped by the demotion counter.
 * Errors are routed to `onError`, never thrown.
 */
function fireDemotion(
  store: ForgeStore,
  brick: BrickArtifact,
  targetTier: ToolPolicy,
  _nowMs: number,
  context: ForgeResolverContext,
): void {
  void store
    .update(brick.id, { policy: targetTier })
    .then(() => {
      context.onDecayDemotion?.(brick.id, brick.policy, targetTier);
    })
    .catch((e: unknown) => {
      context.onError?.(e);
    });
}

/** Drift score threshold above which a brick is demoted. */
const DRIFT_DEMOTION_THRESHOLD = 0.5;

/**
 * Fire-and-forget drift check — updates brick drift context and optionally demotes.
 * Errors are routed to `onError`, never thrown.
 */
function checkDriftAsync(
  store: ForgeStore,
  brick: BrickArtifact,
  context: ForgeResolverContext,
): void {
  const driftContext = brick.driftContext;
  if (driftContext === undefined || context.driftChecker === undefined) return;

  void context.driftChecker
    .checkDrift(driftContext)
    .then(async (driftResult) => {
      if (driftResult === undefined) return;

      const updatedDriftContext: BrickDriftContext = {
        sourceFiles: driftContext.sourceFiles,
        lastCheckedCommit: driftResult.currentCommit,
        driftScore: driftResult.driftScore,
      };

      await store.update(brick.id, { driftContext: updatedDriftContext });

      // Demote if drift score exceeds threshold — drop to lowest tier
      if (driftResult.driftScore >= DRIFT_DEMOTION_THRESHOLD && !brick.policy.sandbox) {
        fireDemotion(store, brick, DEFAULT_SANDBOXED_POLICY, Date.now(), context);
      }
    })
    .catch((e: unknown) => {
      context.onError?.(e);
    });
}

export function createForgeResolver(
  store: ForgeStore,
  context: ForgeResolverContext,
): Resolver<BrickArtifact, BrickArtifact> {
  if (!context.agentId) {
    throw new Error("ForgeResolver requires a non-empty agentId in context");
  }
  const { agentId } = context;

  const discover = async (): Promise<readonly BrickArtifact[]> => {
    const result = await store.search({ orderBy: "trailStrength" });
    if (!result.ok) {
      throw new Error(`ForgeResolver: store search failed: ${result.error.message}`, {
        cause: result.error,
      });
    }
    const visible = filterByAgentScope(result.value, agentId);

    // Emit discovery miss when no bricks are visible
    if (visible.length === 0) {
      context.onDiscoveryMiss?.();
      return visible;
    }

    // Lazy trust decay — evaluate fitness on each visible brick
    const nowMs = Date.now();
    let demotionCount = 0; // let: incremented per demotion in loop
    for (const brick of visible) {
      if (demotionCount >= MAX_DECAY_DEMOTIONS_PER_DISCOVER) break;
      const targetTier = evaluateTrustDecay(brick, nowMs);
      if (targetTier !== undefined) {
        demotionCount++;
        fireDemotion(store, brick, targetTier, nowMs, context);
      }
    }

    return visible;
  };

  const load = async (id: string): Promise<Result<BrickArtifact, KoiError>> => {
    const result = await store.load(brickId(id));
    if (!result.ok) return result;
    if (!isVisibleToAgent(result.value, agentId)) return notFoundError(id);

    // Lazy trust decay on load
    const nowMs = Date.now();
    const targetTier = evaluateTrustDecay(result.value, nowMs);
    if (targetTier !== undefined) {
      fireDemotion(store, result.value, targetTier, nowMs, context);
    }

    // Lazy drift detection on load (fire-and-forget).
    // Concurrent load() calls for the same brick may trigger parallel drift
    // checks. This is benign — the DriftChecker cache deduplicates git calls,
    // and store.update() is idempotent for the same commit hash.
    const brick = result.value;
    if (brick.driftContext?.sourceFiles !== undefined && context.driftChecker !== undefined) {
      checkDriftAsync(store, brick, context);
    }

    return result;
  };

  const source = async (id: string): Promise<Result<SourceBundle, KoiError>> => {
    const result = await store.load(brickId(id));
    if (!result.ok) return result;
    if (!isVisibleToAgent(result.value, agentId)) return notFoundError(id);
    return { ok: true, value: extractSource(result.value) };
  };

  const onChange =
    store.watch !== undefined
      ? (listener: () => void): (() => void) => store.watch?.((_event) => listener()) ?? (() => {})
      : undefined;

  return { discover, load, source, ...(onChange !== undefined ? { onChange } : {}) };
}
