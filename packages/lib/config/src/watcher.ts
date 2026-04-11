/**
 * Debounced file watcher for config hot-reload.
 *
 * Handles three failure modes that `fs.watch()` does NOT handle cleanly on
 * its own:
 *
 * 1. Genuine watcher errors (NFS disconnect, permission loss): the `error`
 *    event is surfaced via `onError`. The watcher keeps retrying — it does
 *    NOT permanently close on a transient error, since hot reload going
 *    silently dead is worse than a noisy error log.
 *
 * 2. Rename-on-save: atomic editors (vim, VS Code) save via
 *    `write temp -> rename(temp, target)`. fs.watch emits `rename` on the
 *    target path and then silently keeps pointing at the now-dead inode.
 *    No further `change` events ever arrive. We re-arm the watcher on
 *    `rename` events by closing the current FSWatcher and re-opening it on
 *    the same path.
 *
 * 3. Slow rename-on-save: the new file may be absent for more than 350 ms
 *    (e.g. filesystem under load, large atomic write). The watcher retries
 *    re-arming with exponential backoff and never gives up until the
 *    caller explicitly disposes. Every failed rearm attempt calls `onError`
 *    so operators see a live signal, but the watcher remains alive and
 *    will recover when the file reappears. (Codex MEDIUM round 1.)
 */

import type { FSWatcher } from "node:fs";
import { statSync, watch } from "node:fs";
import type { ConfigUnsubscribe } from "@koi/core/config";

/** Options for `watchConfigFile()`. */
export interface WatchConfigOptions {
  /** Absolute path to the config file. */
  readonly filePath: string;
  /** Callback invoked (debounced) when the file changes. */
  readonly onChange: () => void | Promise<void>;
  /** Debounce interval in milliseconds. Defaults to 300. */
  readonly debounceMs?: number | undefined;
  /**
   * Called when the watcher observes an error (NFS disconnect, permission
   * loss, failed rearm after a rename). Optional — default is silent.
   *
   * Important: the watcher does NOT close itself on error. It keeps
   * retrying indefinitely. `onError` may be called many times for the same
   * underlying issue.
   */
  readonly onError?: ((err: unknown) => void) | undefined;
}

/**
 * Exponential backoff schedule for rearm retries. Starts at 50 ms and caps
 * at 5 s. Retry attempts are capped at index (length - 1), not the array
 * length, so the watcher retries forever at the 5 s interval.
 */
const REARM_BACKOFF_MS = [50, 100, 200, 500, 1000, 2000, 5000] as const;

/**
 * Watches a config file for changes using `fs.watch()`.
 *
 * Returns an unsubscribe function that stops watching.
 * Multiple rapid writes are coalesced by the debounce interval.
 * Rename-on-save events re-arm the watcher automatically, with
 * exponential-backoff retries if the new file is not immediately visible.
 */
export function watchConfigFile(options: WatchConfigOptions): ConfigUnsubscribe {
  const { filePath, onChange, debounceMs = 300, onError } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rearmTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let fsWatcher: FSWatcher | undefined;
  /**
   * Count of consecutive failed rearm attempts (stat failure OR fs.watch
   * error). Drives the exponential backoff in `scheduleRearm`. Reset to 0
   * on every successful open that stays stable for ≥ 1 debounce interval.
   */
  let failureAttempt = 0;

  const scheduleOnChange = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) {
        void onChange();
      }
    }, debounceMs);
  };

  /**
   * Schedules a rearm attempt with exponential backoff. Idempotent: if a
   * rearm is already scheduled, a second call is a no-op. This is the ONLY
   * path that triggers a retry — both stat failures and `fs.watch` error
   * events route through here, preventing synchronous reopen loops under
   * persistent watcher failure. (Codex HIGH round 3.)
   */
  const scheduleRearm = (): void => {
    if (closed) return;
    if (rearmTimer !== undefined) return;
    const idx = Math.min(failureAttempt, REARM_BACKOFF_MS.length - 1);
    const delay = REARM_BACKOFF_MS[idx] ?? 5000;
    rearmTimer = setTimeout(() => {
      rearmTimer = undefined;
      rearm();
    }, delay);
  };

  const rearm = (): void => {
    if (closed) return;
    try {
      statSync(filePath);
    } catch (statErr: unknown) {
      failureAttempt++;
      // On the FIRST failed stat after a rename/error, trigger a reload via
      // the normal pipeline so the caller sees the real NOT_FOUND / load
      // error through a `rejected` event with reason "load" rather than
      // just synthetic watcher noise. Subsequent retry attempts do not
      // re-fire this — the caller already got the first failure event.
      if (failureAttempt === 1) {
        scheduleOnChange();
      }
      // Only surface the watcher error after the fast-retry window (first
      // 3 attempts) to avoid noise from common brief-absence cases.
      if (failureAttempt >= 3) {
        onError?.(statErr);
      }
      scheduleRearm();
      return;
    }
    // File exists — open a fresh watcher on it. Do NOT reset
    // `failureAttempt` here — that's done only on rename events (the
    // expected-recovery path). If this rearm is recovering from a real
    // error, we want the backoff to keep accumulating so persistent
    // fs.watch failures actually reach the capped 5s delay instead of
    // thrashing at 50-100ms forever. (Codex HIGH round 6-of-session-2.)
    try {
      openWatcher();
      scheduleOnChange();
    } catch (openErr: unknown) {
      failureAttempt++;
      onError?.(openErr);
      scheduleRearm();
    }
  };

  const openWatcher = (): void => {
    fsWatcher?.close();
    fsWatcher = watch(filePath, (eventType) => {
      if (closed) return;
      // On `rename`, the inode the watcher was pointing at is gone. Close
      // the stale watcher and re-arm onto the new file. The rearm path
      // calls `scheduleOnChange()` once after the new watcher is installed,
      // so a single atomic save produces exactly one reload — even when
      // `debounceMs` is shorter than the rearm backoff. (Codex HIGH round 1.)
      //
      // Rename is the EXPECTED recovery path (editors atomically replacing
      // files), so reset the failure backoff here. Error-driven rearms
      // keep their accumulated backoff so persistent watcher failures
      // actually reach the capped delay. (Codex HIGH round 6-of-session-2.)
      if (eventType === "rename") {
        failureAttempt = 0;
        fsWatcher?.close();
        fsWatcher = undefined;
        scheduleRearm();
        return;
      }
      scheduleOnChange();
    });
    fsWatcher.on("error", (err: unknown) => {
      if (closed) return;
      failureAttempt++;
      onError?.(err);
      fsWatcher?.close();
      fsWatcher = undefined;
      // Route through the scheduler — never call rearm() synchronously from
      // an error handler or we risk a hot reopen loop.
      scheduleRearm();
    });
  };

  // Initial open: route through the retry machinery so a missing file or
  // transient fs.watch error at startup doesn't crash the caller. Legacy
  // startup flows that call watchConfigFile before the file exists (e.g.
  // watch() before initialize()) recover via the backoff loop. (Codex HIGH
  // round 6.)
  try {
    statSync(filePath);
    openWatcher();
  } catch (initErr: unknown) {
    onError?.(initErr);
    scheduleRearm();
  }

  return () => {
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (rearmTimer !== undefined) {
      clearTimeout(rearmTimer);
      rearmTimer = undefined;
    }
    fsWatcher?.close();
    fsWatcher = undefined;
  };
}
