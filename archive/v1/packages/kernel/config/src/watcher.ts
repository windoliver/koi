/**
 * File watcher — debounced `fs.watch()` wrapper for config hot-reload.
 *
 * Watches a single config file and calls `onReload` when changes are detected.
 * Debounces rapid filesystem events to avoid redundant reloads.
 *
 * Note: Only watches the main config file. Changes to `$include`'d files
 * are not detected. Monitor included files separately if needed.
 */

import { watch } from "node:fs";
import type { ConfigUnsubscribe } from "@koi/core";

export interface WatchConfigOptions {
  /** Path to the config file to watch. */
  readonly filePath: string;
  /** Callback invoked when the file changes (after debounce). */
  readonly onReload: () => void;
  /** Callback invoked when the watcher encounters an error. */
  readonly onError?: (error: Error) => void;
  /** Debounce interval in milliseconds. Default: 100. */
  readonly debounceMs?: number;
}

/**
 * Watches a config file for changes and calls `onReload` on each change.
 * Returns an unsubscribe function that closes the watcher.
 */
export function watchConfigFile(options: WatchConfigOptions): ConfigUnsubscribe {
  const debounceMs = options.debounceMs ?? 100;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const watcher = watch(options.filePath, () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(options.onReload, debounceMs);
  });

  watcher.on("error", (err: Error) => {
    if (options.onError) {
      options.onError(err);
    }
  });

  return () => {
    watcher.close();
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
