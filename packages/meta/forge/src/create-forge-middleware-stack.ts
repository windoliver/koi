/**
 * createForgeMiddlewareStack — wires the 4 orphaned forge middleware packages
 * into a single, correctly-ordered middleware array.
 *
 * Lives in L3 @koi/forge because it imports from multiple L2 peers
 * (forge-demand, forge-exaptation, forge-optimizer, forge-policy) and the
 * L0u @koi/crystallize package.
 */

import type {
  ForgeScope,
  ForgeStore,
  KoiError,
  KoiMiddleware,
  Result,
  StoreChangeNotifier,
  TurnTrace,
} from "@koi/core";
import { DEFAULT_FORGE_BUDGET } from "@koi/core";
import type { CrystallizeHandle } from "@koi/crystallize";
import { createAutoForgeMiddleware, createCrystallizeMiddleware } from "@koi/crystallize";
import type { ForgeDemandHandle } from "@koi/forge-demand";
import { createForgeDemandDetector } from "@koi/forge-demand";
import type { ExaptationHandle } from "@koi/forge-exaptation";
import { createDefaultExaptationConfig, createExaptationDetector } from "@koi/forge-exaptation";
import { createOptimizerMiddleware } from "@koi/forge-optimizer";
import { createForgeUsageMiddleware } from "@koi/forge-policy";
import type { ForgeConfig } from "@koi/forge-types";

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
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the full forge middleware stack with all 6 middlewares wired.
 *
 * Construction order follows the dependency graph:
 * 1. crystallize (standalone — reads traces)
 * 2. demand (standalone — monitors tool calls)
 * 3. auto-forge (depends on crystallize + demand handles)
 * 4. exaptation (standalone — monitors purpose drift)
 * 5. optimizer (standalone — sweeps on session end)
 * 6. usage (standalone — tracks brick usage)
 *
 * Returned middleware array is sorted by priority:
 * - demand (455), exaptation (465), usage (900),
 *   crystallize (950), auto-forge (960), optimizer (990)
 */
export function createForgeMiddlewareStack(
  config: ForgeMiddlewareStackConfig,
): ForgeMiddlewareStackResult {
  const clock = config.clock ?? Date.now;

  // 1. Crystallize middleware — observe tool call patterns (priority 950)
  const crystallizeHandle = createCrystallizeMiddleware({
    readTraces: config.readTraces,
    clock,
    onCandidatesDetected: () => {
      // auto-forge middleware consumes candidates via handle
    },
  });

  // 2. Forge demand detector — detect capability gaps (priority 455)
  const demandHandle = createForgeDemandDetector({
    budget: DEFAULT_FORGE_BUDGET,
    clock,
    onDemand: () => {
      // auto-forge middleware consumes signals via handle
    },
  });

  // 3. Auto-forge — consumes crystallize + demand handles (priority 960)
  const autoForge = createAutoForgeMiddleware({
    crystallizeHandle,
    demandHandle,
    forgeStore: config.forgeStore,
    scope: config.scope,
    notifier: config.notifier,
    ...(config.onError !== undefined ? { onError: config.onError } : {}),
    clock,
  });

  // 4. Exaptation detector — detect purpose drift (priority 465)
  const exaptationHandle = createExaptationDetector(createDefaultExaptationConfig());

  // 5. Optimizer — sweep on session end (priority 990)
  const optimizer = createOptimizerMiddleware({
    store: config.forgeStore,
    clock,
  });

  // 6. Usage tracking — record brick usage (priority 900)
  const usage = createForgeUsageMiddleware({
    store: config.forgeStore,
    config: config.forgeConfig,
    resolveBrickId: config.resolveBrickId,
  });

  // Return middlewares in priority order (ascending)
  const middlewares: readonly KoiMiddleware[] = [
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
    },
  };
}
