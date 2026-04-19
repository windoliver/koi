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
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

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
    if (pid === undefined) {
      // Unparseable content is only safe to treat as stale when the lock
      // file was atomically published (tmp+linkSync path). The fallback path
      // creates the lock file empty and then writes the token; an unparseable
      // content observation in that window could be a live mid-write owner,
      // not a crashed one. The caller (acquireLockFile) only invokes stale
      // recovery on the atomic path, so empty-content == stale is safe here.
      unlinkSync(lockPath);
      return true;
    }
    if (!pidIsAlive(pid)) {
      unlinkSync(lockPath);
      return true;
    }
    // PID is alive — fail closed. PID reuse after a crash can wedge the
    // store until an operator deletes the lock file, but that's the only
    // safe behavior: age-based eviction of a live-PID lock would evict
    // legitimate long-running writers. Plan 4 adds OS-backed flock which
    // is immune to PID reuse.
    return false;
  } catch {
    return false;
  }
}

interface AcquiredLock {
  readonly fd: number;
  readonly token: string;
}

/**
 * Atomic lock acquisition via tmp-file + hardlink pattern:
 *   1. Create a tmp file exclusively, write PID:UUID, fsync, close.
 *   2. linkSync(tmp, lockPath) — atomic rename-like op that FAILS with
 *      EEXIST if lockPath already exists. Either lockPath appears with
 *      fully-written content, or it doesn't appear at all.
 *   3. Unlink the tmp entry (the inode remains via the hardlink).
 *
 * The hardlink guarantees lockPath is never visible in a partial-content
 * state — critical for tryRemoveStaleLock to reason about ownership
 * without a race where a concurrent opener could delete a live-but-mid-
 * write lock file.
 */
function acquireLockFile(lockPath: string): AcquiredLock {
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const tokenBytes = Buffer.from(token, "utf8");
  const dir = dirname(lockPath);
  const tmpPath = join(dir, `.lock.tmp.${process.pid}.${crypto.randomUUID()}`);

  // Write tmp file with token content, fsync, close.
  const tmpFd = openSync(tmpPath, "wx");
  try {
    let written = 0;
    while (written < tokenBytes.byteLength) {
      written += writeSync(tmpFd, tokenBytes, written, tokenBytes.byteLength - written);
    }
    try {
      fsyncSync(tmpFd);
    } catch {
      /* best-effort */
    }
  } finally {
    closeSync(tmpFd);
  }

  // Atomically link tmp → lockPath. EEXIST means someone else is the owner;
  // try stale recovery once and retry. If the filesystem doesn't support
  // hard links (FUSE, some SMB, some cloud fs), fail closed with a clear
  // error — the alternative (openSync(wx)+write) has a partial-write race
  // that would weaken the single-writer invariant on exactly the backends
  // most likely to have multiple writer processes. Plan 4 adds flock for
  // universal support.
  tryPublishLockViaLink(tmpPath, lockPath);

  // Clean up tmp entry; the lockPath hardlink keeps the inode alive.
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort — tmp may already be gone */
  }

  // Open the lockPath read-only so release has an fd to close in addition
  // to unlinking.
  const fd = openSync(lockPath, "r");
  return { fd, token };
}

/**
 * Publish lockPath via linkSync. Handles EEXIST with one stale-recovery
 * retry. Throws if the filesystem doesn't support hard links — the atomic
 * tmp+link protocol is the only safe path on Plan 2, and the narrow-race
 * openSync(wx) fallback has been deliberately removed. Plan 4 adds flock
 * for universal support.
 */
function tryPublishLockViaLink(tmpPath: string, lockPath: string): void {
  let linkedOk = false;
  try {
    linkSync(tmpPath, lockPath);
    linkedOk = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOSYS" || code === "EPERM" || code === "EXDEV" || code === "ENOTSUP") {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort */
      }
      throw new Error(
        `ArtifactStore: filesystem does not support hard links (code=${code}). Plan 2 requires hard-link-capable storage for safe single-writer enforcement. Plan 4 (#1921) adds flock for universal support.`,
      );
    }
    if (code !== "EEXIST") {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort */
      }
      throw err;
    }
  }

  if (!linkedOk) {
    if (tryRemoveStaleLock(lockPath)) {
      try {
        linkSync(tmpPath, lockPath);
        linkedOk = true;
      } catch (retryErr) {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* best-effort */
        }
        if ((retryErr as NodeJS.ErrnoException)?.code === "EEXIST") {
          throw new Error("ArtifactStore already open by another process");
        }
        throw retryErr;
      }
    } else {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort */
      }
      throw new Error("ArtifactStore already open by another process");
    }
  }
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
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (blobLock !== undefined && blobLockPath !== undefined) {
        releaseLockFile(blobLock, blobLockPath);
        blobLock = undefined;
      }
      process.removeListener("exit", release);
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
    process.removeListener("exit", release);
  };

  process.once("exit", release);

  return release;
}
