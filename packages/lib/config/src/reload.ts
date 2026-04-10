/**
 * ConfigManager — wires store + loader + validation + watcher + event bus.
 *
 * Reload pipeline (per plan §5):
 *   single-flight gate
 *     -> attempted event
 *     -> load file
 *     -> deepMerge + validate
 *     -> diff against current store
 *     -> classify changed paths
 *     -> reject if any path is restart-required
 *     -> store.set
 *     -> applied event
 *     -> changed event (ConfigConsumer handlers)
 *
 * Single-flight: concurrent reload() calls are coalesced into at most one
 * trailing reload. This prevents interleaved store.set() calls when the file
 * watcher fires multiple rapid events.
 */

import type { ChangeNotifier, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { ConfigUnsubscribe, KoiConfig } from "@koi/core/config";
import { classifyChangedPaths } from "./classification.js";
import type { ConfigChange, ConfigConsumer } from "./consumer.js";
import { diffConfig } from "./diff.js";
import type { ConfigReloadEvent } from "./events.js";
import { createConfigEventBus } from "./events.js";
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

/** High-level config manager: store + reload + watch + events. */
export interface ConfigManager {
  /** The reactive config store. */
  readonly store: WritableConfigStore<KoiConfig>;
  /** Re-reads the config file, validates, and updates the store. */
  readonly reload: () => Promise<Result<KoiConfig, KoiError>>;
  /** Starts watching the config file for changes. Returns unsubscribe. */
  readonly watch: () => ConfigUnsubscribe;
  /** Stops watching and cleans up. */
  readonly dispose: () => void;
  /** Typed event bus for reload lifecycle and telemetry. */
  readonly events: ChangeNotifier<ConfigReloadEvent>;
  /**
   * Registers a feature-level consumer that re-binds on every successful
   * reload with a non-empty diff. Returns an unsubscribe function.
   *
   * Consumers are fire-and-forget: rejected promises are swallowed. Use
   * `events` directly if you need telemetry-level granularity.
   */
  readonly registerConsumer: (consumer: ConfigConsumer) => ConfigUnsubscribe;
}

/**
 * Creates a ConfigManager that wires together loading, validation,
 * the reactive store, file watching, and the event bus.
 *
 * Starts with `DEFAULT_KOI_CONFIG` — call `reload()` to load from disk.
 */
export function createConfigManager(options: CreateConfigManagerOptions): ConfigManager {
  const store = createConfigStore<KoiConfig>(DEFAULT_KOI_CONFIG);
  const events = createConfigEventBus();
  let watcherCleanup: ConfigUnsubscribe | undefined;

  // Single-flight reload machinery (plan §5, Codex CRITICAL #1).
  let inflight: Promise<Result<KoiConfig, KoiError>> | null = null;
  let trailing: Promise<Result<KoiConfig, KoiError>> | null = null;

  // Classification only applies to reloads AFTER the initial bind. The first
  // successful reload is treated as bootstrap — all fields are hot-applied
  // regardless of classification, since the process hasn't yet bound anything
  // to the default config.
  let bootstrapped = false;

  const doReload = async (): Promise<Result<KoiConfig, KoiError>> => {
    const filePath = options.filePath;
    events.notify({ kind: "attempted", filePath });

    const loadResult = await loadConfig(filePath, options.loaderOptions);
    if (!loadResult.ok) {
      events.notify({
        kind: "rejected",
        filePath,
        reason: "load",
        error: loadResult.error,
      });
      return loadResult;
    }

    const merged = deepMerge(
      DEFAULT_KOI_CONFIG as unknown as Record<string, unknown>,
      loadResult.value,
    );
    const validated = validateKoiConfig(merged);
    if (!validated.ok) {
      events.notify({
        kind: "rejected",
        filePath,
        reason: "validation",
        error: validated.error,
      });
      return validated;
    }

    const prev = store.get();
    const next = validated.value;
    const changedPaths = diffConfig(prev, next);

    // Empty-diff short-circuit: spurious watcher event, nothing to do.
    // Note: this still counts as a successful bind — a reload that validates
    // to the same value the store already held has still "proven" the file
    // is loadable, so the restart gate should apply to the next reload.
    if (changedPaths.length === 0) {
      bootstrapped = true;
      events.notify({
        kind: "applied",
        filePath,
        prev,
        next,
        changedPaths: [],
      });
      return { ok: true, value: next };
    }

    // Enforce the restart-required gate only AFTER the initial bind. The
    // first reload is bootstrap — the store was still holding defaults and
    // no process state has bound to the "old" value yet.
    if (bootstrapped) {
      const { restart } = classifyChangedPaths(changedPaths);
      if (restart.length > 0) {
        const error: KoiError = {
          code: "VALIDATION",
          message:
            `Config reload rejected: field(s) require restart to apply: ${restart.join(", ")}. ` +
            "The old config remains in effect. Restart the process to apply the change.",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
          context: { restartRequiredPaths: restart, changedPaths: [...changedPaths] },
        };
        events.notify({
          kind: "rejected",
          filePath,
          reason: "restart-required",
          error,
          restartRequiredPaths: restart,
        });
        return { ok: false, error };
      }
    }

    // Commit and notify. (Bootstrap or all-hot.)
    store.set(next);
    bootstrapped = true;
    events.notify({
      kind: "applied",
      filePath,
      prev,
      next,
      changedPaths,
    });
    events.notify({
      kind: "changed",
      filePath,
      prev,
      next,
      changedPaths,
    });
    return { ok: true, value: next };
  };

  const reload = (): Promise<Result<KoiConfig, KoiError>> => {
    if (inflight === null) {
      const p = doReload().finally(() => {
        if (inflight === p) inflight = null;
      });
      inflight = p;
      return p;
    }
    // Something is already running — coalesce all additional callers into one
    // shared trailing reload that fires after the current one finishes.
    if (trailing === null) {
      const currentInflight = inflight;
      trailing = (async () => {
        try {
          await currentInflight;
        } catch {
          // Prior failure is its own caller's problem; we still run trailing.
        }
        const p = doReload().finally(() => {
          if (inflight === p) inflight = null;
        });
        inflight = p;
        trailing = null;
        return p;
      })();
    }
    return trailing;
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

  const registerConsumer = (consumer: ConfigConsumer): ConfigUnsubscribe => {
    return events.subscribe((event) => {
      if (event.kind !== "changed") return;
      const change: ConfigChange = {
        prev: event.prev,
        next: event.next,
        changedPaths: event.changedPaths,
      };
      // Fire-and-forget. Rejected promises are swallowed by ChangeNotifier.
      void consumer.onConfigChange(change);
    });
  };

  return { store, reload, watch, dispose, events, registerConsumer };
}
