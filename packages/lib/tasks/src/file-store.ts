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
 *
 * ## Recovery model (single-writer, crash-tolerant, not multi-process)
 *
 * This store is designed for **one writer per `baseDir`** — typically a single
 * ManagedTaskBoard in a single process. A PID-based lock file (`<baseDir>/.lock`)
 * is acquired on construction and released on dispose. If a second store tries
 * to attach to the same directory while a live PID holds the lock, construction
 * throws with a clear error. If the holder's PID is dead (crash recovery), the
 * stale lock is reclaimed automatically.
 *
 * **Crash boundaries**:
 * - Mid-write crash (between `Bun.write(tmpPath)` and `rename`): the orphaned
 *   `.tmp` file is cleaned on startup. The old task JSON is untouched.
 * - Mid-mutation crash (during a `ManagedTaskBoard.persistBoardDiff` batch):
 *   tasks written before the crash are on disk with their new versions;
 *   tasks after are stale. On restart, the board reloads whatever's on disk.
 *   Consumers should call `recoverOrphanedTasks()` after restart to reset any
 *   in-progress tasks whose owners are no longer alive.
 * - Lock-file crash: the next `createFileTaskBoardStore()` call detects the
 *   dead PID and reclaims the lock automatically.
 *
 * **Not guaranteed**:
 * - Atomic multi-file transactions. A partial `addAll` crash leaves a prefix
 *   of tasks on disk.
 * - Multi-process coordination. The lock is best-effort single-process safety;
 *   truly concurrent processes on the same `baseDir` can race during the
 *   check-then-write window.
 * - Automatic replay of crashed mutations. The caller owns recovery.
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
import { isTask } from "@koi/task-board";
import { createMemoryChangeNotifier } from "@koi/validation";
import { matchesFilter } from "./filter.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FileTaskBoardStoreConfig {
  /** Directory for task JSON files. Created if it does not exist. */
  readonly baseDir: string;
  /** Delete orphaned .tmp files on startup. Default: true. */
  readonly cleanOrphanedTmp?: boolean | undefined;
  /**
   * Acquire a single-process PID lock on construction. Default: true.
   *
   * When enabled, a `.lock` file is written to `baseDir` on creation and
   * deleted on dispose. Creating a second store for the same `baseDir` while
   * a live PID holds the lock throws. Stale locks (dead PID) are reclaimed
   * automatically. Set to `false` only for test harnesses that deliberately
   * create overlapping stores on throwaway directories.
   */
  readonly lock?: boolean | undefined;
}

/** Shape of the single-writer lock file. */
interface LockFileContents {
  readonly pid: number;
  readonly ctime: number;
}

/** Max in-flight file reads during cache hydration — bounds I/O fan-out. */
const ENSURE_CACHE_CONCURRENCY = 32;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TASK_FILE_REGEX = /^task_(\d+)\.json$/;
const TMP_FILE_REGEX = /\.tmp$/;
const LOCK_FILE_NAME = ".lock";

/**
 * Safe-ID shape accepted by the file store. Keeps path traversal impossible:
 * the branded TaskItemId type has no runtime validation (it's an identity cast
 * in L0), so any call site that constructs `taskItemId("../../etc/passwd")`
 * would otherwise write outside baseDir. Defense in depth: reject anything
 * that doesn't match the canonical `task_<N>` shape at the I/O boundary.
 */
const SAFE_TASK_ID_REGEX = /^task_\d+$/;

function assertSafeTaskId(id: TaskItemId): void {
  if (!SAFE_TASK_ID_REGEX.test(id)) {
    throw new Error(`Unsafe task id: "${id}" — file store requires the canonical task_<N> format`);
  }
}

/** Extract the numeric ID from a task filename, or undefined if not a task file. */
function extractIdNumber(filename: string): number | undefined {
  const match = TASK_FILE_REGEX.exec(filename);
  return match !== null && match[1] !== undefined ? parseInt(match[1], 10) : undefined;
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

/** Test whether a PID refers to a live process. Signal 0 never sends a signal. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the single-writer lock on `baseDir`. Throws if held by a live PID.
 * Stale locks (dead PID, malformed file) are reclaimed automatically.
 *
 * Note: this is best-effort single-process safety. Two processes hitting
 * this function simultaneously can still race — there's a check-then-write
 * window. Good enough to catch the common "oops, two ManagedTaskBoards"
 * mistake; not a substitute for an OS-level advisory lock.
 */
async function acquireLock(baseDir: string): Promise<void> {
  const lockPath = join(baseDir, LOCK_FILE_NAME);
  const existingFile = Bun.file(lockPath);
  if (await existingFile.exists()) {
    let existing: LockFileContents | undefined;
    try {
      existing = (await existingFile.json()) as LockFileContents;
    } catch {
      // Malformed lock file — treat as stale and overwrite
    }
    if (existing !== undefined && typeof existing.pid === "number" && isPidAlive(existing.pid)) {
      // Same-process collision is still a bug — two ManagedTaskBoards pointing
      // at the same baseDir will corrupt each other even in one process, so
      // the lock fires regardless of whether the holder is us or someone else.
      const since =
        typeof existing.ctime === "number" ? new Date(existing.ctime).toISOString() : "unknown";
      throw new Error(
        `TaskBoardStore lock held by live process ${String(existing.pid)} (since ${since}). ` +
          `Another ManagedTaskBoard is already writing to ${baseDir}. ` +
          `Release it by disposing the other store, or delete ${lockPath} if the holder crashed.`,
      );
    }
    // Dead PID or malformed — reclaim
  }
  const content: LockFileContents = { pid: process.pid, ctime: Date.now() };
  await Bun.write(lockPath, JSON.stringify(content));
}

/** Release the single-writer lock. Best-effort — errors are swallowed. */
async function releaseLock(baseDir: string): Promise<void> {
  try {
    await unlink(join(baseDir, LOCK_FILE_NAME));
  } catch {
    /* lock may already be gone — fine */
  }
}

/** Read and parse a task JSON file. Returns undefined on any error or invalid shape. */
async function readTaskFile(filePath: string): Promise<Task | undefined> {
  try {
    const file = Bun.file(filePath);
    const raw: unknown = await file.json();
    if (typeof raw !== "object" || raw === null) return undefined;
    const obj = raw as Record<string, unknown>;
    // Backward compat: backfill fields that may be absent in old files,
    // matching createTaskBoard's snapshot handling. Only backfill when
    // truly absent — if present but malformed, reject the file.
    if (!("version" in obj)) {
      obj.version = 0;
    } else if (typeof obj.version !== "number") {
      return undefined;
    }
    if (!("retries" in obj)) {
      obj.retries = 0;
    }
    if (!("createdAt" in obj)) {
      obj.createdAt = 0;
    }
    if (!("updatedAt" in obj)) {
      obj.updatedAt = 0;
    }
    if (!("subject" in obj) && typeof obj.description === "string") {
      obj.subject = obj.description;
    }
    if (!isTask(raw)) return undefined;
    return raw;
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
  const { baseDir, cleanOrphanedTmp = true, lock = true } = config;

  // Ensure base directory exists
  await mkdir(baseDir, { recursive: true });

  // Acquire the single-writer lock BEFORE any other startup work, so a
  // concurrent second construction fails fast without side effects.
  if (lock) {
    await acquireLock(baseDir);
  }

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
    // Skip lock file and any other dotfile — they are not task records
    if (entry === LOCK_FILE_NAME || entry.startsWith(".")) {
      continue;
    }
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

  /** IDs whose on-disk files are corrupt/unreadable. */
  const corruptIds = new Set<TaskItemId>();

  /**
   * Ensure the cache is populated (read all files once).
   *
   * Bounds concurrency to `ENSURE_CACHE_CONCURRENCY` in-flight reads so a
   * board with thousands of tasks cannot exhaust file descriptors or saturate
   * the event loop on first access. The loader is single-pass — each ID is
   * read at most once per cache hydration.
   */
  async function ensureCache(): Promise<void> {
    if (cachePopulated) return;
    const loadOne = async (id: TaskItemId): Promise<void> => {
      const item = await readTaskFile(join(baseDir, taskFilename(id)));
      if (item !== undefined) {
        cache.set(id, item);
      } else {
        // Check if file exists but is corrupt vs truly missing
        const fileExists = await Bun.file(join(baseDir, taskFilename(id))).exists();
        if (fileExists) {
          corruptIds.add(id);
        }
      }
    };
    const ids = [...knownIds];
    for (let offset = 0; offset < ids.length; offset += ENSURE_CACHE_CONCURRENCY) {
      const batch = ids.slice(offset, offset + ENSURE_CACHE_CONCURRENCY);
      await Promise.all(batch.map(loadOne));
    }
    cachePopulated = true;
  }

  /** Throws if any known IDs are corrupt — callers that need a complete board should check. */
  function assertNoCorruption(): void {
    if (corruptIds.size > 0) {
      const ids = [...corruptIds].join(", ");
      throw new Error(
        `Corrupt task files detected: ${ids}. Repair or delete these files before proceeding.`,
      );
    }
  }

  // -- Store methods --------------------------------------------------------

  const get = async (id: TaskItemId): Promise<Task | undefined> => {
    // Boundary validation: defense in depth against path traversal via
    // malformed TaskItemId. Safe IDs never reach disk I/O.
    assertSafeTaskId(id);
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
      corruptIds.delete(id); // File is now readable — clear corruption flag
    }
    return item;
  };

  const put = async (item: Task): Promise<void> => {
    assertSafeTaskId(item.id);
    // Stale-write guard: reject same or older version (single-writer safety net,
    // not multi-process CAS — two processes can still race the read-then-write).
    // When cache is cold for a known ID, read from disk to catch stale snapshots.
    let existing = cache.get(item.id);
    if (existing === undefined && knownIds.has(item.id)) {
      const filePath = join(baseDir, taskFilename(item.id));
      const onDisk = await readTaskFile(filePath);
      if (onDisk !== undefined) {
        cache.set(item.id, onDisk);
        existing = onDisk;
      } else {
        // File is either missing or corrupt. Check which.
        const fileExists = await Bun.file(filePath).exists();
        if (fileExists) {
          // File exists but is corrupt — fail closed to prevent version downgrade
          throw new Error(
            `Cannot write task ${item.id}: existing file is corrupt or unreadable — repair or delete the file`,
          );
        }
        // File is truly missing (deleted externally) — allow write
      }
    }
    if (existing !== undefined && existing.version >= item.version) {
      throw new Error(
        `Version conflict for task ${item.id}: stored version ${String(existing.version)} >= incoming version ${String(item.version)}`,
      );
    }
    const content = JSON.stringify(item, null, 2);
    await atomicWrite(baseDir, item.id, content);
    knownIds.add(item.id);
    cache.set(item.id, item);
    corruptIds.delete(item.id); // Successful write repairs corruption
    notifier.notify({ kind: "put", item });
  };

  const del = async (id: TaskItemId): Promise<void> => {
    assertSafeTaskId(id);
    if (!knownIds.has(id)) return;
    try {
      await unlink(join(baseDir, taskFilename(id)));
    } catch {
      /* file may already be gone */
    }
    knownIds.delete(id);
    cache.delete(id);
    corruptIds.delete(id); // Deleted file is no longer corrupt
    notifier.notify({ kind: "deleted", id });
  };

  const list = async (filter?: TaskBoardStoreFilter): Promise<readonly Task[]> => {
    await ensureCache();
    // Fail loudly if any files are corrupt — callers rebuilding a board
    // from list() must not silently start with partial state.
    assertNoCorruption();
    const result: Task[] = [];
    for (const item of cache.values()) {
      if (matchesFilter(item, filter)) result.push(item);
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
    corruptIds.clear(); // Reset clears corruption state
    cachePopulated = true; // Cache is now accurately empty
    // highWaterMark is intentionally NOT reset
  };

  const dispose = async (): Promise<void> => {
    cache.clear();
    knownIds.clear();
    if (lock) {
      await releaseLock(baseDir);
    }
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
