/**
 * Debounced file watcher for config hot-reload.
 *
 * Handles two failure modes that `fs.watch()` does NOT handle cleanly on its
 * own (Codex HIGH #4):
 *
 * 1. Genuine watcher errors (NFS disconnect, permission loss): the `error`
 *    event is propagated and the watcher is closed.
 *
 * 2. Rename-on-save: atomic editors (vim, VS Code) save via
 *    `write temp -> rename(temp, target)`. fs.watch emits `rename` on the
 *    target path and then silently keeps pointing at the now-dead inode.
 *    No further `change` events ever arrive. We re-arm the watcher on
 *    `rename` events by closing the current FSWatcher and re-opening it on
 *    the same path (with a short retry if the new file isn't visible yet).
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
   * Called when the watcher hits an unrecoverable error (NFS disconnect,
   * permission loss). Optional — default is silent.
   */
  readonly onError?: ((err: unknown) => void) | undefined;
}

const REARM_DELAYS_MS = [50, 100, 200] as const;

/**
 * Watches a config file for changes using `fs.watch()`.
 *
 * Returns an unsubscribe function that stops watching.
 * Multiple rapid writes are coalesced by the debounce interval.
 * Rename-on-save events re-arm the watcher automatically.
 */
export function watchConfigFile(options: WatchConfigOptions): ConfigUnsubscribe {
  const { filePath, onChange, debounceMs = 300, onError } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let fsWatcher: FSWatcher | undefined;

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

  const rearm = (attempt: number): void => {
    if (closed) return;
    try {
      statSync(filePath);
    } catch {
      if (attempt >= REARM_DELAYS_MS.length) {
        // File still gone after all retries — give up and call onError.
        onError?.(new Error(`watchConfigFile: file disappeared: ${filePath}`));
        closed = true;
        return;
      }
      const delay = REARM_DELAYS_MS[attempt] ?? 200;
      setTimeout(() => {
        rearm(attempt + 1);
      }, delay);
      return;
    }
    // File exists — open a fresh watcher on it.
    try {
      openWatcher();
    } catch (err: unknown) {
      onError?.(err);
      closed = true;
    }
  };

  const openWatcher = (): void => {
    fsWatcher?.close();
    fsWatcher = watch(filePath, (eventType) => {
      if (closed) return;
      // On `rename`, the inode the watcher was pointing at is gone. Re-arm
      // onto the new file after scheduling a reload for the current contents.
      if (eventType === "rename") {
        scheduleOnChange();
        fsWatcher?.close();
        fsWatcher = undefined;
        rearm(0);
        return;
      }
      scheduleOnChange();
    });
    fsWatcher.on("error", (err: unknown) => {
      if (closed) return;
      closed = true;
      onError?.(err);
    });
  };

  openWatcher();

  return () => {
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    fsWatcher?.close();
    fsWatcher = undefined;
  };
}
