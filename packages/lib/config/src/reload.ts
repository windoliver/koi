/**
 * ConfigManager — wires store + loader + validation + watcher.
 */

import type { KoiError, Result } from "@koi/core";
import type { ConfigUnsubscribe, KoiConfig } from "@koi/core/config";
import type { LoadConfigOptions } from "./loader.js";
import { loadConfig } from "./loader.js";
import { deepMerge } from "./merge.js";
import { validateKoiConfig } from "./schema.js";
import type { WritableConfigStore } from "./store.js";
import { createConfigStore } from "./store.js";
import { watchConfigFile } from "./watcher.js";

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

/** Sane defaults for all 8 KoiConfig sections. */
export const DEFAULT_KOI_CONFIG: KoiConfig = {
  logLevel: "info",
  telemetry: { enabled: false },
  limits: { maxTurns: 25, maxDurationMs: 300_000, maxTokens: 100_000 },
  loopDetection: { enabled: true, windowSize: 8, threshold: 3 },
  spawn: { maxDepth: 3, maxFanOut: 5, maxTotalProcesses: 20 },
  forge: {
    enabled: true,
    maxForgeDepth: 1,
    maxForgesPerSession: 5,
    defaultScope: "agent",
    defaultPolicy: "sandbox",
  },
  modelRouter: {
    strategy: "fallback",
    targets: [{ provider: "default", model: "default" }],
  },
  features: {},
};

// ---------------------------------------------------------------------------
// ConfigManager
// ---------------------------------------------------------------------------

/** Options for `createConfigManager()`. */
export interface CreateConfigManagerOptions {
  /** Path to the config file. */
  readonly filePath: string;
  /** Options passed through to the loader (env, maxIncludeDepth). */
  readonly loaderOptions?: LoadConfigOptions | undefined;
  /** Debounce interval for file watching in ms. Defaults to 300. */
  readonly watchDebounceMs?: number | undefined;
}

/** High-level config manager: store + reload + watch. */
export interface ConfigManager {
  /** The reactive config store. */
  readonly store: WritableConfigStore<KoiConfig>;
  /** Re-reads the config file, validates, and updates the store. */
  readonly reload: () => Promise<Result<KoiConfig, KoiError>>;
  /** Starts watching the config file for changes. Returns unsubscribe. */
  readonly watch: () => ConfigUnsubscribe;
  /** Stops watching and cleans up. */
  readonly dispose: () => void;
}

/**
 * Creates a ConfigManager that wires together loading, validation,
 * the reactive store, and file watching.
 *
 * Starts with `DEFAULT_KOI_CONFIG` — call `reload()` to load from disk.
 */
export function createConfigManager(options: CreateConfigManagerOptions): ConfigManager {
  const store = createConfigStore<KoiConfig>(DEFAULT_KOI_CONFIG);
  let watcherCleanup: ConfigUnsubscribe | undefined;

  const reload = async (): Promise<Result<KoiConfig, KoiError>> => {
    const loadResult = await loadConfig(options.filePath, options.loaderOptions);
    if (!loadResult.ok) {
      return loadResult;
    }

    const merged = deepMerge(
      DEFAULT_KOI_CONFIG as unknown as Record<string, unknown>,
      loadResult.value,
    );

    const validated = validateKoiConfig(merged);
    if (!validated.ok) {
      return validated;
    }

    store.set(validated.value);
    return { ok: true, value: validated.value };
  };

  const watch = (): ConfigUnsubscribe => {
    watcherCleanup?.();
    watcherCleanup = watchConfigFile({
      filePath: options.filePath,
      onChange: async () => {
        await reload();
      },
      debounceMs: options.watchDebounceMs,
    });
    return watcherCleanup;
  };

  const dispose = (): void => {
    watcherCleanup?.();
    watcherCleanup = undefined;
  };

  return { store, reload, watch, dispose };
}
