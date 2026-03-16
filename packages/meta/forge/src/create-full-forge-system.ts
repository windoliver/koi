/**
 * createFullForgeSystem — one-shot composition root for the entire forge subsystem.
 *
 * Composes: runtime + component provider + pipeline + middleware stack.
 * Lives in L3 @koi/forge because it imports from multiple L2 peers.
 */

import type {
  BrickArtifact,
  ComponentProvider,
  ForgeDemandSignal,
  ForgeScope,
  ForgeStore,
  KoiError,
  KoiMiddleware,
  Result,
  SigningBackend,
  SnapshotStore,
  StoreChangeNotifier,
  TurnTrace,
} from "@koi/core";
import type { CrystallizeHandle } from "@koi/crystallize";
import type { DashboardEvent } from "@koi/dashboard-types";
import type { ForgeDemandHandle } from "@koi/forge-demand";
import type { ExaptationHandle } from "@koi/forge-exaptation";
import type { ForgeComponentProviderInstance } from "@koi/forge-tools";
import {
  createForgeComponentProvider,
  createMemoryStoreChangeNotifier,
  mapBrickToIndexDoc,
} from "@koi/forge-tools";
import type { ForgeConfig, ForgePipeline, SandboxExecutor } from "@koi/forge-types";
import type { FeedbackLoopHandle } from "@koi/middleware-feedback-loop";
import type { Indexer } from "@koi/search-provider";
import type { ForgeMiddlewareStackResult } from "./create-forge-middleware-stack.js";
import { createForgeMiddlewareStack } from "./create-forge-middleware-stack.js";
import { createForgePipeline } from "./create-forge-stack.js";
import type { ForgeRuntimeInstance } from "./forge-runtime.js";
import { createForgeRuntime } from "./forge-runtime.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CreateFullForgeSystemConfig {
  readonly store: ForgeStore;
  readonly executor: SandboxExecutor;
  readonly scope: ForgeScope;
  readonly forgeConfig: ForgeConfig;
  readonly readTraces: () => Promise<Result<readonly TurnTrace[], KoiError>>;
  readonly resolveBrickId: (toolName: string) => string | undefined;
  readonly signer?: SigningBackend | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly clock?: (() => number) | undefined;
  /** Optional notifier for cross-agent cache invalidation. Auto-created when not provided. */
  readonly notifier?: StoreChangeNotifier | undefined;
  /** Optional SnapshotStore for quarantine/demotion event recording. Falls back to no-op. */
  readonly snapshotStore?: SnapshotStore | undefined;
  /** Optional SSE event sink for self-improvement observability. */
  readonly onDashboardEvent?: ((event: DashboardEvent) => void) | undefined;
  /** Optional auto-harness synthesis callback — routed to auto-forge middleware. */
  readonly synthesizeHarness?:
    | ((signal: ForgeDemandSignal) => Promise<BrickArtifact | null>)
    | undefined;
  /** Maximum harness synthesis attempts per session. Default: 3. */
  readonly maxSynthesesPerSession?: number | undefined;
  /** Optional policy-cache handle for promotion wiring. */
  readonly policyCacheHandle?: import("@koi/middleware-policy-cache").PolicyCacheHandle | undefined;
  /** Optional indexer for keeping the search index in sync with the forge store. */
  readonly indexer?: Indexer | undefined;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface FullForgeSystem {
  readonly runtime: ForgeRuntimeInstance;
  readonly provider: ComponentProvider;
  readonly pipeline: ForgePipeline;
  readonly middlewares: readonly KoiMiddleware[];
  readonly notifier: StoreChangeNotifier;
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
 * Create a fully-wired forge system in one call.
 *
 * Composes:
 * - ForgeRuntime (hot-attach tool resolution)
 * - ForgeComponentProvider (ECS brick attachment)
 * - ForgePipeline (cross-L2 operation wiring)
 * - ForgeMiddlewareStack (demand, exaptation, crystallize, auto-forge, optimizer, usage)
 */
export function createFullForgeSystem(config: CreateFullForgeSystemConfig): FullForgeSystem {
  // 0. Notifier — shared pub/sub for cross-agent cache invalidation
  const notifier = config.notifier ?? createMemoryStoreChangeNotifier();

  // 1. Runtime — hot-attach tool resolution with integrity checks
  const runtime = createForgeRuntime({
    store: config.store,
    executor: config.executor,
    dependencyConfig: config.forgeConfig.dependencies,
    ...(config.signer !== undefined ? { signer: config.signer } : {}),
  });

  // 2. Component provider — ECS brick attachment (with notifier for cache invalidation)
  const providerInstance: ForgeComponentProviderInstance = createForgeComponentProvider({
    store: config.store,
    executor: config.executor,
    scope: config.scope,
    notifier,
  });

  // 3. Pipeline — cross-L2 wiring (verify, governance, provenance, etc.)
  const pipeline = createForgePipeline();

  // 4. Middleware stack — all 7 forge middlewares (including feedback loop)
  const stackResult: ForgeMiddlewareStackResult = createForgeMiddlewareStack({
    forgeStore: config.store,
    forgeConfig: config.forgeConfig,
    scope: config.scope,
    readTraces: config.readTraces,
    resolveBrickId: config.resolveBrickId,
    onError: config.onError,
    clock: config.clock,
    notifier,
    snapshotStore: config.snapshotStore,
    onDashboardEvent: config.onDashboardEvent,
    ...(config.synthesizeHarness !== undefined
      ? { synthesizeHarness: config.synthesizeHarness }
      : {}),
    ...(config.maxSynthesesPerSession !== undefined
      ? { maxSynthesesPerSession: config.maxSynthesesPerSession }
      : {}),
    ...(config.policyCacheHandle !== undefined
      ? { policyCacheHandle: config.policyCacheHandle }
      : {}),
  });

  // 5. Indexing subscriber — keeps search index in sync with store mutations
  if (config.indexer !== undefined) {
    const indexer = config.indexer;
    const onError = config.onError;

    /** Report a non-fatal indexing error via onError or console.debug fallback. */
    const reportError = (context: string, error: unknown): void => {
      if (onError !== undefined) {
        onError(error);
      } else {
        console.debug(`[forge] ${context}:`, error);
      }
    };

    notifier.subscribe((event) => {
      if (event.kind === "saved" || event.kind === "updated") {
        void config.store
          .load(event.brickId)
          .then(async (loadResult) => {
            if (!loadResult.ok) return;
            const doc = mapBrickToIndexDoc(loadResult.value);
            const indexResult = await indexer.index([doc]);
            if (!indexResult.ok) {
              reportError("indexing subscriber index failed", indexResult.error);
            }
          })
          .catch((e: unknown) => {
            reportError("indexing subscriber failed", e);
          });
      } else if (event.kind === "removed" || event.kind === "quarantined") {
        void indexer
          .remove([event.brickId])
          .then((removeResult) => {
            if (!removeResult.ok) {
              reportError("indexing subscriber remove failed", removeResult.error);
            }
          })
          .catch((e: unknown) => {
            reportError("indexing subscriber remove failed", e);
          });
      }
    });

    // Async background backfill — index all existing bricks (fire-and-forget).
    // Duplicate index() calls are idempotent upserts by document ID.
    void config.store
      .search({})
      .then(async (searchResult) => {
        if (!searchResult.ok) return;
        const docs = searchResult.value.map(mapBrickToIndexDoc);
        if (docs.length > 0) {
          const indexResult = await indexer.index(docs);
          if (!indexResult.ok) {
            reportError("indexing backfill failed", indexResult.error);
          }
        }
      })
      .catch((e: unknown) => {
        reportError("indexing backfill failed", e);
      });
  }

  return {
    runtime,
    provider: providerInstance,
    pipeline,
    middlewares: stackResult.middlewares,
    notifier,
    handles: stackResult.handles,
  };
}
