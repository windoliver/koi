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
  /**
   * Invoked when a registered `ConfigConsumer` throws or rejects during a
   * `changed` event. The store has already been committed by the time this
   * fires — the consumer's failure has NOT been rolled back. This callback
   * exists so operators can observe split-brain states (store committed
   * but a subsystem failed to rebind).
   *
   * The default behavior is silent: failures are caught so they cannot
   * crash the process, but nothing is logged. Provide this callback to
   * surface them.
   */
  readonly onConsumerError?: ((err: unknown) => void) | undefined;
  /**
   * Invoked when the file watcher observes an infrastructure error (NFS
   * disconnect, permission loss, failed rearm after rename, etc.).
   * Separate from the main `events` bus so watcher-health signals do not
   * conflate with actual config load/validation failures, and so the
   * `attempted → rejected` event lifecycle stays clean. (Codex MEDIUM
   * round 6-of-session-2.)
   *
   * The watcher keeps retrying; this callback may fire repeatedly until
   * the underlying issue clears.
   */
  readonly onWatcherError?: ((err: unknown) => void) | undefined;
}

/** High-level config manager: store + reload + watch + events. */
export interface ConfigManager {
  /** The reactive config store. */
  readonly store: WritableConfigStore<KoiConfig>;
  /**
   * Performs the initial file load. Does NOT enforce the restart-required
   * classification gate — this is a one-shot bootstrap, not a hot reload.
   * Retriable on failure. Idempotent on success.
   *
   * After a successful `initialize()`, all subsequent `reload()` calls
   * enforce classification.
   *
   * Emits `applied` plus (if the diff from defaults is non-empty) `changed`,
   * so any consumer registered before `initialize()` observes the initial
   * bind via the standard pub/sub channel.
   */
  readonly initialize: () => Promise<Result<KoiConfig, KoiError>>;
  /**
   * Re-reads the config file, validates, and updates the store.
   *
   * Enforces the restart-required classification gate on any reload that
   * runs after initialization has succeeded: a reload that touches a
   * restart-required field is rejected as a whole and the old config is
   * retained.
   *
   * **Legacy bootstrap:** calling `reload()` on a fresh manager (before
   * `initialize()`) auto-promotes to `initialize()` as a one-shot bootstrap.
   * New code should prefer the explicit `initialize()` method, but the
   * auto-promotion preserves backward compatibility with the v1 startup
   * sequence `createConfigManager(...) -> await mgr.reload()`.
   */
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

  /**
   * Single-flight machinery. Operations are appended to a serialized
   * promise chain via `tail`. At most one batch runs at a time. Callers
   * of the SAME kind arriving while a batch is pending coalesce into that
   * batch; callers of a DIFFERENT kind get their own batch chained after
   * it — never promoted in place, so an initialize() caller cannot be
   * silently upgraded into reload semantics.
   *
   * There is no `inflight === null` handoff window: new batches chain off
   * `tail` (always the most recently enqueued promise), so a `.then()`
   * continuation of a completed batch that calls `enqueue()` cannot slip
   * in a parallel operation between batches.
   */
  type Batch = {
    kind: "initialize" | "reload";
    readonly promise: Promise<Result<KoiConfig, KoiError>>;
  };
  let tail: Promise<Result<KoiConfig, KoiError>> = Promise.resolve({
    ok: true,
    value: DEFAULT_KOI_CONFIG,
  });
  let pending: Batch | null = null;

  // Phase gating (Codex HIGH round 1). Classification only applies once
  // `initialize()` has been successfully called.
  let initialized = false;
  // Flips true on the FIRST call to initialize() regardless of outcome.
  // Used by the watcher callback to distinguish "caller never tried to
  // initialize" (stay passive) from "caller tried and failed" (retry on
  // watcher events so the caller can recover by fixing the file).
  // (Codex HIGH round 8.)
  let initializeAttempted = false;

  const loadAndValidate = async (): Promise<Result<KoiConfig, KoiError>> => {
    const loadResult = await loadConfig(options.filePath, options.loaderOptions);
    if (!loadResult.ok) return loadResult;
    const merged = deepMerge(
      DEFAULT_KOI_CONFIG as unknown as Record<string, unknown>,
      loadResult.value,
    );
    return validateKoiConfig(merged);
  };

  /**
   * Strict reload: enforces classification, emits the full event lifecycle.
   *
   * If `initialized === false` at entry, delegates to `doInitialize()` for
   * one-shot bootstrap. This preserves the legacy startup flow where a
   * caller could call `reload()` on a fresh manager without an explicit
   * `initialize()` call first. New code should prefer `initialize()`.
   */
  const doReload = async (): Promise<Result<KoiConfig, KoiError>> => {
    if (!initialized) {
      // Delegate to doInitialize for backward compatibility.
      return doInitialize();
    }

    const filePath = options.filePath;
    events.notify({ kind: "attempted", filePath });

    const validated = await loadAndValidate();
    if (!validated.ok) {
      const reason: "load" | "validation" =
        validated.error.code === "VALIDATION" ? "validation" : "load";
      events.notify({ kind: "rejected", filePath, reason, error: validated.error });
      return validated;
    }

    const prev = store.get();
    const next = validated.value;
    const changedPaths = diffConfig(prev, next);

    // Empty-diff short-circuit: spurious watcher event, nothing to do.
    if (changedPaths.length === 0) {
      events.notify({
        kind: "applied",
        filePath,
        prev,
        next,
        changedPaths: [],
      });
      return { ok: true, value: next };
    }

    // Strict classification: any restart-required path rejects the whole reload.
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

    // All changed paths are hot-applicable. Commit and notify.
    store.set(next);
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

  /**
   * Initial load: no classification gate. Idempotent once successful.
   * Retriable on failure.
   *
   * Pre-init consumers (registered via `registerConsumer()` before the first
   * successful `initialize()`) receive a `changed` event when the loaded
   * config differs from `DEFAULT_KOI_CONFIG`. If the loaded config is
   * byte-identical to defaults, no `changed` event fires (empty diff =
   * nothing to rebind). Consumers that need to observe bootstrap regardless
   * of diff must read `mgr.store.get()` after `initialize()` returns.
   * See `docs/L2/config.md` for the known-limitation note.
   */
  const doInitialize = async (): Promise<Result<KoiConfig, KoiError>> => {
    const filePath = options.filePath;
    initializeAttempted = true;
    events.notify({ kind: "attempted", filePath });

    if (initialized) {
      // Idempotent no-op. Return current store value.
      const current = store.get();
      events.notify({
        kind: "applied",
        filePath,
        prev: current,
        next: current,
        changedPaths: [],
      });
      return { ok: true, value: current };
    }

    const validated = await loadAndValidate();
    if (!validated.ok) {
      const reason: "load" | "validation" =
        validated.error.code === "VALIDATION" ? "validation" : "load";
      events.notify({ kind: "rejected", filePath, reason, error: validated.error });
      return validated;
    }

    const prev = store.get();
    const next = validated.value;
    const changedPaths = diffConfig(prev, next);
    store.set(next);
    initialized = true;

    events.notify({
      kind: "applied",
      filePath,
      prev,
      next,
      changedPaths,
    });
    // Fire `changed` only if the initial bind is a real diff from the
    // defaults. If the loaded config is byte-identical to
    // `DEFAULT_KOI_CONFIG`, no consumer needs to rebind — the store value
    // is the same. This matches the reload path's "empty diff => no
    // changed event" rule. Pre-init consumers that need to observe
    // bootstrap regardless of diff must read `mgr.store.get()` after
    // calling `initialize()`. (See `docs/L2/config.md` for the
    // known-limitation note on path-gated consumers and empty bootstrap
    // diffs.)
    if (changedPaths.length > 0) {
      events.notify({
        kind: "changed",
        filePath,
        prev,
        next,
        changedPaths,
      });
    }
    return { ok: true, value: next };
  };

  /**
   * Single-flight queue: appends work to a serialized promise chain and
   * coalesces concurrent callers of the SAME kind into one batch.
   *
   * A caller can only join an existing pending batch if it requested the
   * same operation kind. Promoting an already-queued `initialize` batch
   * to `reload` would silently upgrade earlier initialize() callers into
   * reload semantics (restart-required rejections, different post-init
   * classification), which breaks their idempotency contract. Instead,
   * a different-kind caller gets its own batch chained after `tail`.
   * (Codex HIGH round 7-of-session-2.)
   */
  const enqueue = (kind: "initialize" | "reload"): Promise<Result<KoiConfig, KoiError>> => {
    // Join an existing pending batch only if it matches our requested kind.
    if (pending !== null && pending.kind === kind) {
      return pending.promise;
    }
    // Create a new batch that chains off `tail`. Because `tail` is always
    // the most recently enqueued promise, the new batch is strictly ordered
    // after every prior batch with no scheduling gap.
    const batch: Batch = {
      kind,
      promise: undefined as unknown as Promise<Result<KoiConfig, KoiError>>,
    };
    (batch as { promise: Promise<Result<KoiConfig, KoiError>> }).promise = tail
      // Swallow prior errors so one failed batch never blocks the chain.
      .catch(() => undefined)
      .then(async () => {
        // Clear the pending pointer BEFORE running so new callers that
        // arrive during this batch's execution create a fresh batch.
        const finalKind = batch.kind;
        if (pending === batch) pending = null;
        const run = finalKind === "initialize" ? doInitialize : doReload;
        return run();
      });
    pending = batch;
    tail = batch.promise;
    return batch.promise;
  };

  const initialize = (): Promise<Result<KoiConfig, KoiError>> => {
    // Short-circuit: already initialized, return current state without
    // queueing. This preserves the documented idempotent contract even
    // under concurrency — an initialize() racing with a reload() must
    // never be promoted into a reload operation, because that would
    // surface validation / restart-required errors that the caller did
    // not ask for. (Codex HIGH round 1 follow-up.)
    if (initialized) {
      const current = store.get();
      const filePath = options.filePath;
      events.notify({ kind: "attempted", filePath });
      events.notify({
        kind: "applied",
        filePath,
        prev: current,
        next: current,
        changedPaths: [],
      });
      return Promise.resolve({ ok: true, value: current });
    }
    return enqueue("initialize");
  };
  const reload = (): Promise<Result<KoiConfig, KoiError>> => enqueue("reload");

  const watch = (): ConfigUnsubscribe => {
    watcherCleanup?.();
    watcherCleanup = watchConfigFile({
      filePath: options.filePath,
      onChange: async () => {
        if (!initialized) {
          // Two sub-cases for uninitialized state:
          //   (a) The caller has not yet attempted initialize() — stay
          //       passive. Silent bootstrap via the watcher would bypass the
          //       caller's explicit startup sequencing. (Codex HIGH round 7.)
          //   (b) The caller has tried initialize() and it failed — retry on
          //       every file event so fixing the file can recover the
          //       manager without an external retry. (Codex HIGH round 8.)
          if (initializeAttempted) {
            await initialize();
          }
          return;
        }
        await reload();
      },
      debounceMs: options.watchDebounceMs,
      // Surface watcher errors through the optional `onWatcherError`
      // callback, NOT the events bus. This keeps the `attempted → rejected`
      // event lifecycle clean and prevents telemetry from misclassifying
      // dead-watcher / permission / NFS failures as config load failures.
      // (Codex MEDIUM round 6-of-session-2.)
      onError: (err: unknown) => {
        try {
          options.onWatcherError?.(err);
        } catch {
          /* swallow — onWatcherError itself should not break the watcher */
        }
      },
    });
    return watcherCleanup;
  };

  const dispose = (): void => {
    watcherCleanup?.();
    watcherCleanup = undefined;
  };

  /**
   * Fire-and-forget invocation of a consumer handler. Catches both sync
   * throws and async rejections so one failing consumer cannot terminate
   * the process or block other consumers. (Codex HIGH round 1 of session 1.)
   *
   * Failures are surfaced via the optional `onConsumerError` option
   * (rather than a new event kind, to avoid widening the exported
   * `ConfigReloadEvent` discriminated union). Operators that care about
   * split-brain detection provide an `onConsumerError` callback at
   * manager construction time.
   */
  const safeInvokeConsumer = (consumer: ConfigConsumer, change: ConfigChange): void => {
    const reportFailure = (err: unknown): void => {
      try {
        options.onConsumerError?.(err);
      } catch {
        /* swallow — onConsumerError itself should not break the loop */
      }
    };
    try {
      const result = consumer.onConfigChange(change);
      if (result !== undefined && result !== null) {
        Promise.resolve(result).catch((err: unknown) => {
          reportFailure(err);
        });
      }
    } catch (err: unknown) {
      reportFailure(err);
    }
  };

  const registerConsumer = (consumer: ConfigConsumer): ConfigUnsubscribe => {
    // Callable at any time. If `initialize()` hasn't run yet, the consumer
    // will receive the initial bind via the `changed` event that
    // `initialize()` emits on success. Post-init consumers that need the
    // current snapshot should read `mgr.store.get()` at registration time.
    return events.subscribe((event) => {
      if (event.kind !== "changed") return;
      safeInvokeConsumer(consumer, {
        prev: event.prev,
        next: event.next,
        changedPaths: event.changedPaths,
      });
    });
  };

  return { store, initialize, reload, watch, dispose, events, registerConsumer };
}
