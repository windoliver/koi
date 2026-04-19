/**
 * Layer 1 of §3.0: exclusive advisory locks on <dbPath>.lock AND
 * <blobDir>/.writer.lock. Two locks close two separate cross-store races:
 *   - dbPath lock: prevents two writer processes from opening the same
 *     metadata DB concurrently.
 *   - blobDir lock: prevents two metadata DBs (including :memory: DBs that
 *     skip the dbPath lock) from sharing a single blob backend.
 * :memory: databases skip the dbPath lock but STILL acquire the blobDir
 * lock, closing the "two in-memory stores share one blobDir" hole.
 *
 * Implementation uses O_CREAT | O_EXCL (exclusive-create) semantics, with a
 * PID-liveness check to recover from SIGKILL'd owners that couldn't run the
 * normal exit handler. A proper OS-backed flock is Plan 4's hardening — this
 * file-based approach is sufficient for single-host deployments.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_SUFFIX = ".lock";
const BLOBDIR_LOCK_NAME = ".writer.lock";

function isInMemory(dbPath: string): boolean {
  return dbPath === ":memory:" || dbPath.startsWith("file::memory:");
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    // EPERM means the pid exists but we lack permission — process is alive.
    if ((err as NodeJS.ErrnoException)?.code === "EPERM") return true;
    throw err;
  }
}

function tryRemoveStaleLock(lockPath: string): boolean {
  try {
    const content = readFileSync(lockPath, "utf8").trim();
    const pid = Number(content);
    if (Number.isNaN(pid)) return false;
    if (pidIsAlive(pid)) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireLockFile(lockPath: string): number {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      if (tryRemoveStaleLock(lockPath)) {
        try {
          fd = openSync(lockPath, "wx");
        } catch (retryErr) {
          if ((retryErr as NodeJS.ErrnoException)?.code === "EEXIST") {
            throw new Error("ArtifactStore already open by another process");
          }
          throw retryErr;
        }
      } else {
        throw new Error("ArtifactStore already open by another process");
      }
    } else {
      throw err;
    }
  }
  return fd;
}

function releaseLockFile(fd: number, lockPath: string): void {
  // CRITICAL ordering: unlink BEFORE closing the fd. On POSIX, unlink-while-
  // open is safe — the pathname is removed immediately, but our fd remains
  // valid. If we close first, a successor process can acquire the same path
  // via O_EXCL before we unlink, and our unlink then silently deletes the
  // successor's lock file (reopening concurrent-writer races). On Windows,
  // unlink-while-open may fail; the fallback close-then-unlink is still
  // usable there, with a narrower race window.
  let unlinkedSuccessfully = false;
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
      unlinkedSuccessfully = true;
    }
  } catch {
    /* Windows may refuse unlink-while-open; fall through to close + retry. */
  }
  try {
    closeSync(fd);
  } catch {
    /* ignore close errors */
  }
  if (!unlinkedSuccessfully) {
    // Windows fallback: unlink after close. Race window exists but tiny;
    // main targets are POSIX.
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      /* ignore — another process may have already cleaned up */
    }
  }
}

export function acquireLock(dbPath: string, blobDir?: string): () => void {
  // Layer 1a: blobDir lock (always, if provided). Covers :memory: DBs so
  // two in-memory stores cannot share one blob backend.
  let blobLockFd: number | undefined;
  let blobLockPath: string | undefined;
  if (blobDir !== undefined) {
    blobLockPath = join(blobDir, BLOBDIR_LOCK_NAME);
    blobLockFd = acquireLockFile(blobLockPath);
    writeFileSync(blobLockFd, String(process.pid));
  }

  // Layer 1b: dbPath lock (skipped for :memory:).
  if (isInMemory(dbPath)) {
    const release = (): void => {
      if (blobLockFd !== undefined && blobLockPath !== undefined) {
        releaseLockFile(blobLockFd, blobLockPath);
        blobLockFd = undefined;
      }
    };
    process.once("exit", release);
    return release;
  }

  const lockPath = `${dbPath}${LOCK_SUFFIX}`;

  let fd: number;
  try {
    fd = acquireLockFile(lockPath);
  } catch (err) {
    // Failed to acquire dbPath lock — release the blobDir lock we grabbed.
    if (blobLockFd !== undefined && blobLockPath !== undefined) {
      releaseLockFile(blobLockFd, blobLockPath);
    }
    throw err;
  }

  writeFileSync(fd, String(process.pid));

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseLockFile(fd, lockPath);
    if (blobLockFd !== undefined && blobLockPath !== undefined) {
      releaseLockFile(blobLockFd, blobLockPath);
      blobLockFd = undefined;
    }
  };

  process.once("exit", release);

  return release;
}
