/**
 * Shared forge bootstrap factory — single entry point for both CLI and starter.
 *
 * Creates the full forge system with graceful degradation: if forge
 * initialization fails, the agent starts without self-improvement
 * capabilities rather than crashing.
 */

import type {
  ComponentProvider,
  ForgeScope,
  ForgeStore,
  KoiError,
  KoiMiddleware,
  Result,
  SigningBackend,
  SnapshotStore,
  TurnTrace,
} from "@koi/core";
import type { ForgeComponentProviderInstance } from "@koi/forge-tools";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import type { ForgeConfig, SandboxExecutor } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import type { Indexer, Retriever } from "@koi/search-provider";
import { createForgeToolsProvider } from "./create-forge-tools-provider.js";
import type { FullForgeSystem } from "./create-full-forge-system.js";
import { createFullForgeSystem } from "./create-full-forge-system.js";
import type { ForgeRuntimeInstance } from "./forge-runtime.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for forge bootstrap. */
export interface ForgeBootstrapConfig {
  /** Override forge config. Defaults to createDefaultForgeConfig(). */
  readonly forgeConfig?: Partial<ForgeConfig> | undefined;
  /** Override forge store. Defaults to in-memory store. */
  readonly store?: ForgeStore | undefined;
  /** Sandbox executor for forged bricks. */
  readonly executor: SandboxExecutor;
  /** Visibility scope. Default: "agent". */
  readonly scope?: ForgeScope | undefined;
  /** Trace reader for crystallize/auto-forge. */
  readonly readTraces?: (() => Promise<Result<readonly TurnTrace[], KoiError>>) | undefined;
  /** Brick ID resolver for demand detector. */
  readonly resolveBrickId?: ((toolName: string) => string | undefined) | undefined;
  /** Optional signing backend. */
  readonly signer?: SigningBackend | undefined;
  /** Optional SnapshotStore for quarantine/demotion event recording. Falls back to no-op. */
  readonly snapshotStore?: SnapshotStore | undefined;
  /** Error callback. */
  readonly onError?: ((error: unknown) => void) | undefined;
  /** Clock function for testing. */
  readonly clock?: (() => number) | undefined;
  /** Resolve the current engine session ID. Resets forge counter on change. */
  readonly resolveSessionId?: (() => string) | undefined;
  /** Optional auto-harness synthesis callback — routed to auto-forge middleware. */
  readonly synthesizeHarness?:
    | ((
        signal: import("@koi/core").ForgeDemandSignal,
      ) => Promise<import("@koi/core").BrickArtifact | null>)
    | undefined;
  /** Maximum harness synthesis attempts per session. Default: 3. */
  readonly maxSynthesesPerSession?: number | undefined;
  /** Optional policy-cache handle for promotion wiring. */
  readonly policyCacheHandle?: import("@koi/middleware-policy-cache").PolicyCacheHandle | undefined;
  /** Optional hybrid retriever for semantic brick discovery. */
  readonly retriever?: Retriever | undefined;
  /** Optional indexer for keeping the search index in sync with the forge store. */
  readonly indexer?: Indexer | undefined;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Successful forge bootstrap result — everything needed for createKoi(). */
export interface ForgeBootstrapResult {
  /** The forge runtime, passed as `options.forge` to createKoi(). */
  readonly runtime: ForgeRuntimeInstance;
  /** Forge middleware, merged into `options.middleware`. */
  readonly middlewares: readonly KoiMiddleware[];
  /** Component provider, merged into `options.providers`. */
  readonly provider: ComponentProvider;
  /** The forge store instance (for companion skill registration). */
  readonly store: ForgeStore;
  /** Full forge system handle (for advanced use). */
  readonly system: FullForgeSystem;
  /** Provider that exposes the 5 primordial forge tools + companion skill. */
  readonly forgeToolsProvider: ComponentProvider;
  /** Tear down forge runtime + provider store subscriptions. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Bootstrap the forge self-improvement system.
 *
 * Returns ForgeBootstrapResult on success, undefined on failure.
 * On failure, logs a warning and the agent starts without forge.
 * This is Decision #8A: graceful degradation.
 */
export function createForgeBootstrap(
  config: ForgeBootstrapConfig,
): ForgeBootstrapResult | undefined {
  try {
    const forgeConfig = createDefaultForgeConfig(config.forgeConfig);

    if (!forgeConfig.enabled) {
      return undefined;
    }

    const store = config.store ?? createInMemoryForgeStore();
    const scope = config.scope ?? forgeConfig.defaultScope;

    const system = createFullForgeSystem({
      store,
      executor: config.executor,
      scope,
      forgeConfig,
      readTraces: config.readTraces ?? (async () => ({ ok: true as const, value: [] })),
      resolveBrickId: config.resolveBrickId ?? (() => undefined),
      signer: config.signer,
      onError: config.onError,
      clock: config.clock,
      snapshotStore: config.snapshotStore,
      ...(config.synthesizeHarness !== undefined
        ? { synthesizeHarness: config.synthesizeHarness }
        : {}),
      ...(config.maxSynthesesPerSession !== undefined
        ? { maxSynthesesPerSession: config.maxSynthesesPerSession }
        : {}),
      ...(config.policyCacheHandle !== undefined
        ? { policyCacheHandle: config.policyCacheHandle }
        : {}),
      ...(config.indexer !== undefined ? { indexer: config.indexer } : {}),
    });

    // Cast provider to its full instance type for dispose access.
    // createFullForgeSystem returns ForgeComponentProviderInstance (which
    // extends ComponentProvider) but FullForgeSystem.provider is typed as the
    // base ComponentProvider interface.
    const providerInstance = system.provider as ForgeComponentProviderInstance;

    const forgeToolsProvider = createForgeToolsProvider({
      store,
      executor: config.executor,
      forgeConfig,
      notifier: system.notifier,
      pipeline: system.pipeline,
      ...(config.resolveSessionId !== undefined
        ? { resolveSessionId: config.resolveSessionId }
        : {}),
      ...(config.retriever !== undefined ? { retriever: config.retriever } : {}),
      ...(config.onError !== undefined ? { onError: config.onError } : {}),
    });

    return {
      runtime: system.runtime,
      middlewares: system.middlewares,
      provider: system.provider,
      store,
      system,
      forgeToolsProvider,
      dispose: (): void => {
        system.runtime.dispose?.();
        providerInstance.dispose();
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Decision #8A: graceful degradation — log and continue without forge
    if (config.onError !== undefined) {
      config.onError(error);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[koi] forge bootstrap failed, starting without self-improvement: ${message}`);
    }
    return undefined;
  }
}
