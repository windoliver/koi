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

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
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

function parseLockPid(content: string): number | undefined {
  // New format: "PID:UUID". Back-compat: bare "PID" (older locks).
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  const pidStr = trimmed.includes(":") ? trimmed.split(":", 1)[0] : trimmed;
  if (pidStr === undefined) return undefined;
  const pid = Number(pidStr);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function tryRemoveStaleLock(lockPath: string): boolean {
  try {
    const content = readFileSync(lockPath, "utf8");
    const pid = parseLockPid(content);
    // Unparseable or empty lock contents mean the previous owner crashed
    // mid-write (or someone corrupted the file). Treat as stale rather than
    // blocking every future open — the lock-file mechanism only claims
    // advisory single-writer semantics, not crash-proof forensics.
    if (pid === undefined) {
      unlinkSync(lockPath);
      return true;
    }
    if (pidIsAlive(pid)) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

interface AcquiredLock {
  readonly fd: number;
  readonly token: string;
}

function acquireLockFile(lockPath: string): AcquiredLock {
  const token = `${process.pid}:${crypto.randomUUID()}`;
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
  // Write the owner token (PID:UUID) so release can verify ownership before
  // unlinking. The UUID ensures uniqueness even across PID reuse. fsync so
  // a SIGKILL'd owner doesn't leave a zero-length file that would block
  // future stale-lock recovery.
  const tokenBytes = Buffer.from(token, "utf8");
  let written = 0;
  while (written < tokenBytes.byteLength) {
    written += writeSync(fd, tokenBytes, written, tokenBytes.byteLength - written);
  }
  try {
    fsyncSync(fd);
  } catch {
    /* best-effort — not all fs support fsync on the fd we just opened with wx */
  }
  return { fd, token };
}

function releaseLockFile(lock: AcquiredLock, lockPath: string): void {
  // CRITICAL ordering: unlink BEFORE closing the fd. On POSIX, unlink-while-
  // open is safe — the pathname is removed immediately, but our fd remains
  // valid. If we close first, a successor process can acquire the same path
  // via O_EXCL before we unlink, and our unlink then silently deletes the
  // successor's lock file (reopening concurrent-writer races).
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
    closeSync(lock.fd);
  } catch {
    /* ignore close errors */
  }
  if (!unlinkedSuccessfully) {
    // Windows fallback: close has completed, so the file may now be unlinkable.
    // A successor could have already acquired the path via O_EXCL in that
    // window, so we MUST verify the on-disk token still matches ours before
    // removing it. Otherwise we'd delete the successor's lock.
    try {
      if (existsSync(lockPath)) {
        const onDisk = readFileSync(lockPath, "utf8").trim();
        if (onDisk === lock.token) {
          unlinkSync(lockPath);
        }
        // If the on-disk token differs, a successor has claimed the path;
        // leave their lock alone.
      }
    } catch {
      /* ignore — another process may have already cleaned up */
    }
  }
}

export function acquireLock(dbPath: string, blobDir?: string): () => void {
  // Layer 1a: blobDir lock (always, if provided). Covers :memory: DBs so
  // two in-memory stores cannot share one blob backend.
  let blobLock: AcquiredLock | undefined;
  let blobLockPath: string | undefined;
  if (blobDir !== undefined) {
    blobLockPath = join(blobDir, BLOBDIR_LOCK_NAME);
    blobLock = acquireLockFile(blobLockPath);
  }

  // Layer 1b: dbPath lock (skipped for :memory:).
  if (isInMemory(dbPath)) {
    const release = (): void => {
      if (blobLock !== undefined && blobLockPath !== undefined) {
        releaseLockFile(blobLock, blobLockPath);
        blobLock = undefined;
      }
    };
    process.once("exit", release);
    return release;
  }

  const lockPath = `${dbPath}${LOCK_SUFFIX}`;

  let dbLock: AcquiredLock;
  try {
    dbLock = acquireLockFile(lockPath);
  } catch (err) {
    // Failed to acquire dbPath lock — release the blobDir lock we grabbed.
    if (blobLock !== undefined && blobLockPath !== undefined) {
      releaseLockFile(blobLock, blobLockPath);
    }
    throw err;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseLockFile(dbLock, lockPath);
    if (blobLock !== undefined && blobLockPath !== undefined) {
      releaseLockFile(blobLock, blobLockPath);
      blobLock = undefined;
    }
  };

  process.once("exit", release);

  return release;
}
