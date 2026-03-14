/**
 * createForgeMiddlewareStack — wires the forge middleware packages
 * into a single, correctly-ordered middleware array.
 *
 * Lives in L3 @koi/forge because it imports from multiple L2 peers
 * (forge-demand, forge-exaptation, forge-optimizer, forge-policy,
 * middleware-feedback-loop) and the L0u @koi/crystallize package.
 */

import type {
  BrickId,
  BrickSnapshot,
  ForgeScope,
  ForgeStore,
  KoiError,
  KoiMiddleware,
  Result,
  SnapshotId,
  SnapshotQuery,
  SnapshotStore,
  StoreChangeNotifier,
  TurnTrace,
} from "@koi/core";
import { DEFAULT_FORGE_BUDGET, RETRYABLE_DEFAULTS } from "@koi/core";
import type { CrystallizeHandle } from "@koi/crystallize";
import { createAutoForgeMiddleware, createCrystallizeMiddleware } from "@koi/crystallize";
import type { ForgeDemandHandle } from "@koi/forge-demand";
import { createForgeDemandDetector } from "@koi/forge-demand";
import type { ExaptationHandle } from "@koi/forge-exaptation";
import { createDefaultExaptationConfig, createExaptationDetector } from "@koi/forge-exaptation";
import { createOptimizerMiddleware } from "@koi/forge-optimizer";
import { createForgeUsageMiddleware } from "@koi/forge-policy";
import type { ForgeConfig } from "@koi/forge-types";
import type { FeedbackLoopHandle } from "@koi/middleware-feedback-loop";
import {
  createFeedbackLoopMiddleware,
  createForgeRepairStrategy,
} from "@koi/middleware-feedback-loop";

// ---------------------------------------------------------------------------
// Forge-specific retry budgets (Issue #937: 4A)
// ---------------------------------------------------------------------------

/** Forge-tuned retry: 5 validation attempts (research-optimal), 3 transport. */
const FORGE_RETRY_CONFIG = {
  validation: { maxAttempts: 5, delayMs: 0 },
  transport: { maxAttempts: 3 },
} as const;

// ---------------------------------------------------------------------------
// No-op SnapshotStore fallback (when caller doesn't provide one)
// ---------------------------------------------------------------------------

const NOT_FOUND: Result<BrickSnapshot, KoiError> = {
  ok: false,
  error: {
    code: "NOT_FOUND",
    message: "No-op snapshot store",
    retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
  },
};

function createNoOpSnapshotStore(): SnapshotStore {
  return {
    record: (_snapshot: BrickSnapshot): Promise<Result<void, KoiError>> =>
      Promise.resolve({ ok: true, value: undefined }),
    get: (_id: SnapshotId): Promise<Result<BrickSnapshot, KoiError>> => Promise.resolve(NOT_FOUND),
    list: (_query: SnapshotQuery): Promise<Result<readonly BrickSnapshot[], KoiError>> =>
      Promise.resolve({ ok: true, value: [] }),
    history: (_brickId: BrickId): Promise<Result<readonly BrickSnapshot[], KoiError>> =>
      Promise.resolve({ ok: true, value: [] }),
    latest: (_brickId: BrickId): Promise<Result<BrickSnapshot, KoiError>> =>
      Promise.resolve(NOT_FOUND),
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ForgeMiddlewareStackConfig {
  readonly forgeStore: ForgeStore;
  readonly forgeConfig: ForgeConfig;
  readonly scope: ForgeScope;
  readonly readTraces: () => Promise<Result<readonly TurnTrace[], KoiError>>;
  readonly resolveBrickId: (toolName: string) => string | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly clock?: (() => number) | undefined;
  /** Optional notifier for cross-agent cache invalidation after store mutations. */
  readonly notifier?: StoreChangeNotifier | undefined;
  /** Optional SnapshotStore for quarantine/demotion event recording. Falls back to no-op. */
  readonly snapshotStore?: SnapshotStore | undefined;
  /**
   * Optional auto-harness synthesis callback. When provided, failure-driven
   * demand signals are routed to harness synthesis instead of pioneer stubs.
   * Created via createAutoHarnessStack() from @koi/auto-harness.
   */
  readonly synthesizeHarness?:
    | ((
        signal: import("@koi/core").ForgeDemandSignal,
      ) => Promise<import("@koi/core").BrickArtifact | null>)
    | undefined;
  /** Maximum harness synthesis attempts per session. Default: 3. */
  readonly maxSynthesesPerSession?: number | undefined;
  /** Optional policy-cache middleware to add to the stack (priority 150). */
  readonly policyCacheMiddleware?: KoiMiddleware | undefined;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ForgeMiddlewareStackResult {
  readonly middlewares: readonly KoiMiddleware[];
  readonly handles: {
    readonly demand: ForgeDemandHandle;
    readonly crystallize: CrystallizeHandle;
    readonly exaptation: ExaptationHandle;
    readonly feedbackLoop: FeedbackLoopHandle;
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the full forge middleware stack with all 7 middlewares wired.
 *
 * Construction order follows the dependency graph:
 * 1. feedback-loop (standalone — health tracking, retry with repair)
 * 2. crystallize (standalone — reads traces)
 * 3. demand (standalone — monitors tool calls)
 * 4. auto-forge (depends on crystallize + demand handles)
 * 5. exaptation (standalone — monitors purpose drift)
 * 6. optimizer (standalone — sweeps on session end)
 * 7. usage (standalone — tracks brick usage)
 *
 * Returned middleware array is sorted by priority:
 * - feedback-loop (450), demand (455), exaptation (465), usage (900),
 *   crystallize (950), auto-forge (960), optimizer (990)
 */
export function createForgeMiddlewareStack(
  config: ForgeMiddlewareStackConfig,
): ForgeMiddlewareStackResult {
  const clock = config.clock ?? Date.now;
  const snapshotStore = config.snapshotStore ?? createNoOpSnapshotStore();

  // 1. Feedback-loop middleware — validate, retry with forge repair, health tracking (priority 450)
  //    Uses lazy repair strategy to break circular dependency: the forge repair strategy
  //    needs the FeedbackLoopHandle (for health snapshots), which is returned by the factory.
  const feedbackLoopHandle = createFeedbackLoopMiddleware({
    retry: FORGE_RETRY_CONFIG,
    repairStrategy: () =>
      createForgeRepairStrategy({
        forgeStore: config.forgeStore,
        healthTracker: { getSnapshot: feedbackLoopHandle.getHealthSnapshot },
        resolveBrickId: config.resolveBrickId,
      }),
    forgeHealth: {
      resolveBrickId: config.resolveBrickId,
      forgeStore: config.forgeStore,
      snapshotStore,
      clock,
      onQuarantine: (brickId: string): void => {
        config.onError?.(new Error(`Forge tool quarantined: ${brickId}`));
      },
      onFlushError: (toolId: string, error: unknown): void => {
        config.onError?.(new Error(`Forge health flush failed for ${toolId}`, { cause: error }));
      },
      onDemotionError: (toolId: string, error: unknown): void => {
        config.onError?.(new Error(`Forge demotion check failed for ${toolId}`, { cause: error }));
      },
    },
  });

  // 2. Crystallize middleware — observe tool call patterns (priority 950)
  const crystallizeHandle = createCrystallizeMiddleware({
    readTraces: config.readTraces,
    clock,
    onCandidatesDetected: () => {
      // auto-forge middleware consumes candidates via handle
    },
  });

  // 3. Forge demand detector — detect capability gaps (priority 455)
  const demandHandle = createForgeDemandDetector({
    budget: DEFAULT_FORGE_BUDGET,
    clock,
    onDemand: () => {
      // auto-forge middleware consumes signals via handle
    },
  });

  // 4. Auto-forge — consumes crystallize + demand handles (priority 960)
  //    When synthesizeHarness is provided, failure-driven demand signals are routed
  //    to harness synthesis instead of creating pioneer stubs.
  const autoForge = createAutoForgeMiddleware({
    crystallizeHandle,
    demandHandle,
    forgeStore: config.forgeStore,
    scope: config.scope,
    notifier: config.notifier,
    ...(config.onError !== undefined ? { onError: config.onError } : {}),
    ...(config.synthesizeHarness !== undefined
      ? { synthesizeHarness: config.synthesizeHarness }
      : {}),
    ...(config.maxSynthesesPerSession !== undefined
      ? { maxSynthesesPerSession: config.maxSynthesesPerSession }
      : {}),
    clock,
  });

  // 5. Exaptation detector — detect purpose drift (priority 465)
  const exaptationHandle = createExaptationDetector(createDefaultExaptationConfig());

  // 6. Optimizer — sweep on session end (priority 990)
  const optimizer = createOptimizerMiddleware({
    store: config.forgeStore,
    clock,
    ...(config.notifier !== undefined ? { notifier: config.notifier } : {}),
  });

  // 7. Usage tracking — record brick usage (priority 900)
  const usage = createForgeUsageMiddleware({
    store: config.forgeStore,
    config: config.forgeConfig,
    resolveBrickId: config.resolveBrickId,
  });

  // Return middlewares in priority order (ascending)
  const middlewares: readonly KoiMiddleware[] = [
    // Policy-cache at priority 150 (before permissions) — only when auto-harness is wired
    ...(config.policyCacheMiddleware !== undefined ? [config.policyCacheMiddleware] : []),
    feedbackLoopHandle.middleware, // 450
    demandHandle.middleware, // 455
    exaptationHandle.middleware, // 465
    usage, // 900
    crystallizeHandle.middleware, // 950
    autoForge, // 960
    optimizer, // 990
  ];

  return {
    middlewares,
    handles: {
      demand: demandHandle,
      crystallize: crystallizeHandle,
      exaptation: exaptationHandle,
      feedbackLoop: feedbackLoopHandle,
    },
  };
}
