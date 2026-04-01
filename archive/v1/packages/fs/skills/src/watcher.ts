/**
 * Filesystem watcher for skill directories.
 *
 * Watches directories for added/changed/removed SKILL.md files using
 * the FsForgeStore pattern: recursive watch + rescan-and-diff.
 */

import { type FSWatcher, watch as fsWatch } from "node:fs";
import { exists } from "node:fs/promises";
import { basename, join } from "node:path";
import { discoverSkillDirs } from "./loader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillWatchEvent =
  | { readonly kind: "added"; readonly dirPath: string; readonly name: string }
  | { readonly kind: "changed"; readonly dirPath: string; readonly name: string }
  | { readonly kind: "removed"; readonly dirPath: string; readonly name: string };

export interface SkillWatcherConfig {
  readonly dirs: readonly string[];
  readonly debounceMs?: number;
  readonly onChange: (event: SkillWatchEvent) => void;
}

export interface SkillWatcher {
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 250;

export function createSkillFileWatcher(config: SkillWatcherConfig): SkillWatcher {
  const { dirs, debounceMs = DEFAULT_DEBOUNCE_MS, onChange } = config;

  const watchers: FSWatcher[] = [];
  // Map of dir → known skill names (basename of skill dir)
  const knownSkills = new Map<string, Set<string>>();
  // let: debounce timers per watched directory
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // let: toggled by dispose() to prevent leaked FSWatchers from async init
  let disposed = false;

  const scanAndDiff = async (watchedDir: string): Promise<void> => {
    const discoverResult = await discoverSkillDirs(watchedDir);
    if (!discoverResult.ok) return;

    const currentDirs = new Set(discoverResult.value);
    const currentNames = new Set<string>();
    const dirByName = new Map<string, string>();

    for (const d of currentDirs) {
      const name = basename(d);
      currentNames.add(name);
      dirByName.set(name, d);
    }

    const known = knownSkills.get(watchedDir) ?? new Set<string>();

    // Detect added
    for (const name of currentNames) {
      if (!known.has(name)) {
        const dirPath = dirByName.get(name);
        if (dirPath !== undefined) {
          try {
            onChange({ kind: "added", dirPath, name });
          } catch {
            // Decision 15A — non-fatal
          }
        }
      }
    }

    // Detect removed
    for (const name of known) {
      if (!currentNames.has(name)) {
        const dirPath = join(watchedDir, name);
        try {
          onChange({ kind: "removed", dirPath, name });
        } catch {
          // non-fatal
        }
      }
    }

    // Detect changed — for simplicity, treat all existing skills as potentially changed
    // The downstream consumer (mount) clears cache + reloads, so false positives are safe
    for (const name of currentNames) {
      if (known.has(name)) {
        const dirPath = dirByName.get(name);
        if (dirPath !== undefined) {
          try {
            onChange({ kind: "changed", dirPath, name });
          } catch {
            // non-fatal
          }
        }
      }
    }

    knownSkills.set(watchedDir, currentNames);
  };

  const debouncedScan = (watchedDir: string): void => {
    const existing = timers.get(watchedDir);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    timers.set(
      watchedDir,
      setTimeout(() => {
        timers.delete(watchedDir);
        void scanAndDiff(watchedDir);
      }, debounceMs),
    );
  };

  // Initialize watchers
  const initPromises: Promise<void>[] = [];

  for (const dir of dirs) {
    initPromises.push(
      (async () => {
        const dirExists = await exists(dir);
        if (!dirExists) {
          // Decision 16A — skip + log if missing
          console.debug(`[skill-watcher] Skipping non-existent directory: ${dir}`);
          return;
        }

        // Initial scan to populate known set
        const discoverResult = await discoverSkillDirs(dir);
        if (discoverResult.ok) {
          const names = new Set<string>();
          for (const d of discoverResult.value) {
            names.add(basename(d));
          }
          knownSkills.set(dir, names);
        }

        // Check disposed flag after each await to prevent leaked FSWatchers
        if (disposed) return;

        try {
          const watcher = fsWatch(dir, { recursive: true }, (_eventType, filename) => {
            if (disposed) return;
            // Only react to changes in SKILL.md files
            if (filename !== null && typeof filename === "string") {
              const base = basename(filename);
              if (base === "SKILL.md") {
                debouncedScan(dir);
              }
            }
          });

          // If disposed while creating the watcher, close immediately
          if (disposed) {
            watcher.close();
            return;
          }
          watchers.push(watcher);
        } catch {
          // Decision 15A — non-fatal
          console.debug(`[skill-watcher] Failed to watch directory: ${dir}`);
        }
      })(),
    );
  }

  // Fire-and-forget initialization
  void Promise.allSettled(initPromises);

  const dispose = (): void => {
    disposed = true;
    for (const watcher of watchers) {
      watcher.close();
    }
    watchers.length = 0;
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  };

  return { dispose };
}
