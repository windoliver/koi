/**
 * Config manager — composes store + loader + reload() + watch().
 */

import type { ConfigStore, ConfigUnsubscribe, KoiConfig, KoiError, Result } from "@koi/core";
import { loadConfig } from "./loader.js";
import { deepMerge } from "./merge.js";
import { validateKoiConfig } from "./schema.js";
import type { WritableConfigStore } from "./store.js";
import { createConfigStore } from "./store.js";
import { watchConfigFile } from "./watcher.js";

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_KOI_CONFIG: KoiConfig = Object.freeze({
  logLevel: "info",
  telemetry: Object.freeze({ enabled: false }),
  limits: Object.freeze({ maxTurns: 25, maxDurationMs: 300_000, maxTokens: 100_000 }),
  loopDetection: Object.freeze({ enabled: true, windowSize: 8, threshold: 3 }),
  spawn: Object.freeze({ maxDepth: 3, maxFanOut: 5, maxTotalProcesses: 20 }),
  forge: Object.freeze({
    enabled: true,
    maxForgeDepth: 1,
    maxForgesPerSession: 5,
    defaultScope: "agent",
    defaultTrustTier: "sandbox",
  }),
  modelRouter: Object.freeze({
    strategy: "fallback",
    targets: Object.freeze([Object.freeze({ provider: "default", model: "default" })]),
  }),
  features: Object.freeze({}),
});

// ---------------------------------------------------------------------------
// Manager interface
// ---------------------------------------------------------------------------

export interface ConfigManager {
  /** The reactive config store (read-only view). */
  readonly store: ConfigStore<KoiConfig>;
  /**
   * Reloads config from the file, validates, merges with defaults,
   * and pushes to the store. Returns the validation result.
   */
  readonly reload: () => Promise<Result<KoiConfig, KoiError>>;
  /**
   * Starts watching the config file for changes and auto-reloads.
   * Returns an unsubscribe function to stop watching.
   * Multiple calls are safe — each returns its own unsubscribe.
   */
  readonly watch: () => ConfigUnsubscribe;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateConfigManagerOptions {
  /** Path to the config file. */
  readonly filePath: string;
  /** Initial config overrides applied on top of defaults. */
  readonly initial?: Partial<KoiConfig>;
  /** Environment variables for interpolation. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Called when a watch-triggered reload fails (parse/validation error). */
  readonly onReloadError?: (error: KoiError) => void;
}

/**
 * Creates a config manager that loads from a file and maintains a reactive store.
 *
 * The initial store value is `DEFAULT_KOI_CONFIG` merged with `options.initial`.
 * Call `reload()` to load from disk and push updates to subscribers.
 */
export function createConfigManager(options: CreateConfigManagerOptions): ConfigManager {
  const initialConfig =
    options.initial !== undefined
      ? (deepMerge(
          DEFAULT_KOI_CONFIG as unknown as Record<string, unknown>,
          options.initial as unknown as Partial<Record<string, unknown>>,
        ) as unknown as KoiConfig)
      : DEFAULT_KOI_CONFIG;

  const store: WritableConfigStore<KoiConfig> = createConfigStore(initialConfig);

  const reload = async (): Promise<Result<KoiConfig, KoiError>> => {
    const loaded = await loadConfig(options.filePath, { env: options.env });
    if (!loaded.ok) {
      return loaded;
    }

    const merged = deepMerge(
      DEFAULT_KOI_CONFIG as unknown as Record<string, unknown>,
      loaded.value,
    );

    const validated = validateKoiConfig(merged);
    if (!validated.ok) {
      return validated;
    }

    store.set(validated.value);
    return validated;
  };

  const watchFn = (): ConfigUnsubscribe =>
    watchConfigFile({
      filePath: options.filePath,
      onReload: () => {
        void reload().then((result) => {
          if (!result.ok && options.onReloadError) {
            options.onReloadError(result.error);
          }
        });
      },
    });

  return { store, reload, watch: watchFn };
}
