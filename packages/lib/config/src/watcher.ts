/**
 * Debounced file watcher for config hot-reload.
 */

import { watch } from "node:fs";
import type { ConfigUnsubscribe } from "@koi/core/config";

/** Options for `watchConfigFile()`. */
export interface WatchConfigOptions {
  /** Absolute path to the config file. */
  readonly filePath: string;
  /** Callback invoked (debounced) when the file changes. */
  readonly onChange: () => void | Promise<void>;
  /** Debounce interval in milliseconds. Defaults to 300. */
  readonly debounceMs?: number | undefined;
}

/**
 * Watches a config file for changes using `fs.watch()`.
 *
 * Returns an unsubscribe function that stops watching.
 * Multiple rapid writes are coalesced by the debounce interval.
 */
export function watchConfigFile(options: WatchConfigOptions): ConfigUnsubscribe {
  const { filePath, onChange, debounceMs = 300 } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const fsWatcher = watch(filePath, () => {
    if (closed) return;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) {
        void onChange();
      }
    }, debounceMs);
  });

  return () => {
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    fsWatcher.close();
  };
}
