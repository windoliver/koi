/**
 * File-based lock for cross-process mutual exclusion.
 *
 * Uses mkdir atomicity: creating a directory is atomic on all POSIX
 * filesystems and Windows. The lock directory contains a metadata file
 * with PID and timestamp for stale-lock detection.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileLock {
  readonly withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
}

interface LockMeta {
  readonly pid: number;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_LOCK_MS = 30_000;
const POLL_INTERVAL_MS = 50;
const MAX_WAIT_MS = 10_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFileLock(lockDir?: string): FileLock {
  const dir = lockDir ?? join(homedir(), ".koi", "locks");

  async function acquireLock(key: string): Promise<string> {
    // Ensure base lock directory exists on first use
    await mkdir(dir, { recursive: true });

    const lockPath = join(dir, `${sanitizeKey(key)}.lock`);
    const metaPath = join(lockPath, "meta.json");
    const deadline = Date.now() + MAX_WAIT_MS;

    while (Date.now() < deadline) {
      try {
        await mkdir(lockPath, { recursive: false });
        // Lock acquired — write metadata
        const meta: LockMeta = { pid: process.pid, createdAt: Date.now() };
        await writeFile(metaPath, JSON.stringify(meta), "utf8");
        return lockPath;
      } catch (e: unknown) {
        if (!isExistsError(e)) throw e;

        // Lock exists — check if stale
        if (await isStale(metaPath)) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }

        // Wait and retry
        await sleep(POLL_INTERVAL_MS);
      }
    }

    throw new Error(`Failed to acquire lock for "${key}" after ${MAX_WAIT_MS}ms`);
  }

  async function releaseLock(lockPath: string): Promise<void> {
    await rm(lockPath, { recursive: true, force: true });
  }

  const withLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const lockPath = await acquireLock(key);
    try {
      return await fn();
    } finally {
      await releaseLock(lockPath);
    }
  };

  return { withLock };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isExistsError(e: unknown): boolean {
  return e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "EEXIST";
}

async function isStale(metaPath: string): Promise<boolean> {
  try {
    const raw = await readFile(metaPath, "utf8");
    const meta = JSON.parse(raw) as LockMeta;
    return Date.now() - meta.createdAt > STALE_LOCK_MS;
  } catch {
    // Can't read metadata — treat as stale
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
