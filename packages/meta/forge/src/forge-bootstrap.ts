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
  TurnTrace,
} from "@koi/core";
import type { ForgeComponentProviderInstance } from "@koi/forge-tools";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import type { ForgeConfig, SandboxExecutor } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
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
  /** Error callback. */
  readonly onError?: ((error: unknown) => void) | undefined;
  /** Clock function for testing. */
  readonly clock?: (() => number) | undefined;
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
    });

    // Cast provider to its full instance type for dispose access.
    // createFullForgeSystem returns ForgeComponentProviderInstance (which
    // extends ComponentProvider) but FullForgeSystem.provider is typed as the
    // base ComponentProvider interface.
    const providerInstance = system.provider as ForgeComponentProviderInstance;

    return {
      runtime: system.runtime,
      middlewares: system.middlewares,
      provider: system.provider,
      store,
      system,
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
