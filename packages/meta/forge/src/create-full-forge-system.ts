/**
 * createFullForgeSystem — one-shot composition root for the entire forge subsystem.
 *
 * Composes: runtime + component provider + pipeline + middleware stack.
 * Lives in L3 @koi/forge because it imports from multiple L2 peers.
 */

import type {
  ComponentProvider,
  ForgeScope,
  ForgeStore,
  KoiError,
  KoiMiddleware,
  Result,
  SigningBackend,
  TurnTrace,
} from "@koi/core";
import type { CrystallizeHandle } from "@koi/crystallize";
import type { ForgeDemandHandle } from "@koi/forge-demand";
import type { ExaptationHandle } from "@koi/forge-exaptation";
import type { ForgeComponentProviderInstance } from "@koi/forge-tools";
import { createForgeComponentProvider } from "@koi/forge-tools";
import type { ForgeConfig, ForgePipeline, SandboxExecutor } from "@koi/forge-types";
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
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface FullForgeSystem {
  readonly runtime: ForgeRuntimeInstance;
  readonly provider: ComponentProvider;
  readonly pipeline: ForgePipeline;
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
 * Create a fully-wired forge system in one call.
 *
 * Composes:
 * - ForgeRuntime (hot-attach tool resolution)
 * - ForgeComponentProvider (ECS brick attachment)
 * - ForgePipeline (cross-L2 operation wiring)
 * - ForgeMiddlewareStack (demand, exaptation, crystallize, auto-forge, optimizer, usage)
 */
export function createFullForgeSystem(config: CreateFullForgeSystemConfig): FullForgeSystem {
  // 1. Runtime — hot-attach tool resolution with integrity checks
  const runtime = createForgeRuntime({
    store: config.store,
    executor: config.executor,
    dependencyConfig: config.forgeConfig.dependencies,
    ...(config.signer !== undefined ? { signer: config.signer } : {}),
  });

  // 2. Component provider — ECS brick attachment
  const providerInstance: ForgeComponentProviderInstance = createForgeComponentProvider({
    store: config.store,
    executor: config.executor,
    scope: config.scope,
  });

  // 3. Pipeline — cross-L2 wiring (verify, governance, provenance, etc.)
  const pipeline = createForgePipeline();

  // 4. Middleware stack — all 6 forge middlewares
  const stackResult: ForgeMiddlewareStackResult = createForgeMiddlewareStack({
    forgeStore: config.store,
    forgeConfig: config.forgeConfig,
    scope: config.scope,
    readTraces: config.readTraces,
    resolveBrickId: config.resolveBrickId,
    onError: config.onError,
    clock: config.clock,
  });

  return {
    runtime,
    provider: providerInstance,
    pipeline,
    middlewares: stackResult.middlewares,
    handles: stackResult.handles,
  };
}
