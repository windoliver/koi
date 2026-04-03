/**
 * File-based TaskBoardStore implementation.
 *
 * One JSON file per task in a flat directory. Uses atomic
 * write-to-temp + rename for crash safety. Write-through cache
 * for fast reads after initial population.
 *
 * Layout: `<baseDir>/task_<N>.json`
 * Startup: scan filenames only (no content reads), compute HWM from IDs.
 * Cache: populated lazily on first get()/list(), write-through on put()/delete().
 */

import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  Task,
  TaskBoardStore,
  TaskBoardStoreEvent,
  TaskBoardStoreFilter,
  TaskItemId,
} from "@koi/core";
import { taskItemId } from "@koi/core";
import { createMemoryChangeNotifier } from "@koi/validation";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FileTaskBoardStoreConfig {
  /** Directory for task JSON files. Created if it does not exist. */
  readonly baseDir: string;
  /** Delete orphaned .tmp files on startup. Default: true. */
  readonly cleanOrphanedTmp?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TASK_FILE_REGEX = /^task_(\d+)\.json$/;
const TMP_FILE_REGEX = /\.tmp$/;

/** Extract the numeric ID from a task filename, or undefined if not a task file. */
function extractIdNumber(filename: string): number | undefined {
  const match = TASK_FILE_REGEX.exec(filename);
  return match !== null ? parseInt(match[1]!, 10) : undefined;
}

/** Build the filename for a task ID. */
function taskFilename(id: TaskItemId): string {
  return `${id}.json`;
}

/** Build a unique temp filename for atomic writes. */
function tmpFilename(id: TaskItemId): string {
  const ts = String(Date.now());
  const rand = Math.random().toString(36).slice(2, 8);
  return `${id}.json.${ts}.${rand}.tmp`;
}

/** Atomic write: write to temp, then rename to final path. */
async function atomicWrite(baseDir: string, id: TaskItemId, content: string): Promise<void> {
  const finalPath = join(baseDir, taskFilename(id));
  const tmpPath = join(baseDir, tmpFilename(id));
  try {
    await Bun.write(tmpPath, content);
    await rename(tmpPath, finalPath);
  } catch (err: unknown) {
    // Best-effort cleanup of orphaned temp
    try {
      await unlink(tmpPath);
    } catch {
      /* may not exist */
    }
    throw new Error(`Atomic write failed for ${finalPath}`, { cause: err });
  }
}

/** Read and parse a task JSON file. Returns undefined on any error. */
async function readTaskFile(filePath: string): Promise<Task | undefined> {
  try {
    const file = Bun.file(filePath);
    return (await file.json()) as Task;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a file-based TaskBoardStore.
 *
 * Scans the base directory on construction to compute the high water mark
 * from existing filenames (no content reads). Content is loaded lazily
 * into a write-through cache on first access.
 */
export async function createFileTaskBoardStore(
  config: FileTaskBoardStoreConfig,
): Promise<TaskBoardStore> {
  const { baseDir, cleanOrphanedTmp = true } = config;

  // Ensure base directory exists
  await mkdir(baseDir, { recursive: true });

  // Scan filenames to compute HWM and build known-IDs set
  const knownIds = new Set<TaskItemId>();
  let highWaterMark = 0;
  let cachePopulated = false;

  // Write-through cache — populated lazily, updated on every put/delete
  const cache = new Map<TaskItemId, Task>();

  const notifier = createMemoryChangeNotifier<TaskBoardStoreEvent>();

  // Startup scan: filenames only, no content reads
  const entries = await readdir(baseDir);
  for (const entry of entries) {
    if (cleanOrphanedTmp && TMP_FILE_REGEX.test(entry)) {
      // Best-effort cleanup of orphaned temp files
      try {
        await unlink(join(baseDir, entry));
      } catch {
        /* non-fatal */
      }
      continue;
    }
    const num = extractIdNumber(entry);
    if (num !== undefined) {
      const id = taskItemId(`task_${String(num)}`);
      knownIds.add(id);
      if (num > highWaterMark) {
        highWaterMark = num;
      }
    }
  }

  /** Ensure the cache is populated (read all files once). */
  async function ensureCache(): Promise<void> {
    if (cachePopulated) return;
    const loadPromises = [...knownIds].map(async (id) => {
      const item = await readTaskFile(join(baseDir, taskFilename(id)));
      if (item !== undefined) {
        cache.set(id, item);
      } else {
        // Self-heal: file missing or corrupted
        knownIds.delete(id);
      }
    });
    await Promise.all(loadPromises);
    cachePopulated = true;
  }

  // -- Store methods --------------------------------------------------------

  const get = async (id: TaskItemId): Promise<Task | undefined> => {
    // Check cache first
    if (cache.has(id)) {
      return cache.get(id);
    }
    if (!knownIds.has(id)) {
      return undefined;
    }
    // Cache miss for a known ID — load from disk
    const item = await readTaskFile(join(baseDir, taskFilename(id)));
    if (item !== undefined) {
      cache.set(id, item);
    } else {
      knownIds.delete(id); // Self-heal
    }
    return item;
  };

  const put = async (item: Task): Promise<void> => {
    const content = JSON.stringify(item, null, 2);
    await atomicWrite(baseDir, item.id, content);
    knownIds.add(item.id);
    cache.set(item.id, item);
    notifier.notify({ kind: "put", item });
  };

  const del = async (id: TaskItemId): Promise<void> => {
    if (!knownIds.has(id)) return;
    try {
      await unlink(join(baseDir, taskFilename(id)));
    } catch {
      /* file may already be gone */
    }
    knownIds.delete(id);
    cache.delete(id);
    notifier.notify({ kind: "deleted", id });
  };

  const list = async (filter?: TaskBoardStoreFilter): Promise<readonly Task[]> => {
    await ensureCache();
    const result: Task[] = [];
    for (const item of cache.values()) {
      if (filter?.status !== undefined && item.status !== filter.status) continue;
      if (filter?.assignedTo !== undefined && item.assignedTo !== filter.assignedTo) continue;
      result.push(item);
    }
    return result;
  };

  const nextId = (): TaskItemId => {
    highWaterMark += 1;
    return taskItemId(`task_${String(highWaterMark)}`);
  };

  const reset = async (): Promise<void> => {
    // Delete all task files
    const deletePromises = [...knownIds].map(async (id) => {
      try {
        await unlink(join(baseDir, taskFilename(id)));
      } catch {
        /* best effort */
      }
    });
    await Promise.all(deletePromises);
    knownIds.clear();
    cache.clear();
    cachePopulated = true; // Cache is now accurately empty
    // highWaterMark is intentionally NOT reset
  };

  const dispose = async (): Promise<void> => {
    cache.clear();
    knownIds.clear();
  };

  return {
    get,
    put,
    delete: del,
    list,
    nextId,
    watch: notifier.subscribe,
    reset,
    [Symbol.asyncDispose]: dispose,
  };
}
