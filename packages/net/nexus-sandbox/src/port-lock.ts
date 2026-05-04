/**
 * Per-port advisory lock for the nexus sandbox lifecycle.
 *
 * Lock semantics:
 *   - File existence under `~/.nexus/sandbox-locks/<host>-<port>.lock` is
 *     the authoritative claim. Created with O_CREAT | O_EXCL so concurrent
 *     `acquirePortLock()` callers cannot both succeed.
 *   - The lock file body records the owner pid + acquire timestamp + an
 *     OWNER-controlled stale-deadline. Peer readers consult the deadline so
 *     a slow startup (long `healthTimeoutMs`) cannot be reclaimed by a
 *     concurrent caller with a shorter timeout.
 *   - Stale takeover is serialized through a per-lock `<lock>.reclaim`
 *     sentinel so two callers passing `lockIsStale()` cannot both
 *     unlink-and-recreate the lock. The sentinel itself self-recovers if
 *     a previous reclaimer crashed mid-takeover (RECLAIM_LOCK_TTL_MS).
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PORT_LOCK_DIR: string = join(homedir(), ".nexus", "sandbox-locks");
const RECLAIM_LOCK_TTL_MS = 5_000;

export interface PortLockHandle {
  readonly release: () => void;
}

export function acquirePortLock(
  host: string,
  port: number,
  portIsFree: boolean,
  stalenessMs: number,
): PortLockHandle | null {
  const lockPath = join(PORT_LOCK_DIR, `${host}-${String(port)}.lock`);
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // mkdirSync can fail on read-only filesystems / permission errors; in
    // that case fall through and let openSync surface the underlying error.
  }
  const fd = tryCreateLockFile(lockPath, stalenessMs);
  if (fd === null) {
    if (portIsFree && lockIsStale(lockPath, stalenessMs)) {
      return reclaimStaleLock(lockPath, stalenessMs);
    }
    return null;
  }
  return makeLockHandle(fd, lockPath);
}

function reclaimStaleLock(lockPath: string, stalenessMs: number): PortLockHandle | null {
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimFd: number | null = null;
  try {
    reclaimFd = openSync(reclaimPath, "wx");
  } catch {
    // Reclaim sentinel exists; bail unless it's ancient (wedged reclaimer).
    try {
      const st = statSync(reclaimPath);
      if (Date.now() - st.mtimeMs < RECLAIM_LOCK_TTL_MS) return null;
      try {
        unlinkSync(reclaimPath);
      } catch {
        return null;
      }
      reclaimFd = openSync(reclaimPath, "wx");
    } catch {
      return null;
    }
  }
  try {
    // Re-check under the reclaim sentinel. A concurrent reclaimer that beat
    // us into the critical section may have already swapped the lock for a
    // fresh one; in that case lockIsStale returns false and we conflict.
    if (!lockIsStale(lockPath, stalenessMs)) return null;
    try {
      unlinkSync(lockPath);
    } catch {
      /* concurrent reclaim; fall through */
    }
    const fresh = tryCreateLockFile(lockPath, stalenessMs);
    if (fresh === null) return null;
    return makeLockHandle(fresh, lockPath);
  } finally {
    if (reclaimFd !== null) {
      try {
        closeSync(reclaimFd);
      } catch {
        /* fd already closed */
      }
    }
    try {
      unlinkSync(reclaimPath);
    } catch {
      /* sentinel already cleaned up */
    }
  }
}

/**
 * Lock file format: `pid\tlocked_at_iso\tdeadline_ms_epoch\n`
 * The deadline is OWNER-supplied, so a peer reader honors the owner's
 * configured startup window even under heterogeneous healthTimeoutMs. Falls
 * back to the peer's own staleness window if the file is unparseable.
 */
function lockIsStale(lockPath: string, fallbackStalenessMs: number): boolean {
  try {
    const text = readFileSync(lockPath, "utf-8");
    const parts = text.trim().split("\t");
    const deadline = parts.length >= 3 ? Number.parseInt(parts[2] ?? "", 10) : Number.NaN;
    if (Number.isFinite(deadline)) return Date.now() > deadline;
    // Unparseable owner metadata — fall back to peer-supplied window vs mtime.
    const st = statSync(lockPath);
    return Date.now() - st.mtimeMs > fallbackStalenessMs;
  } catch {
    // statSync/read failure on a path we just observed via openSync's EEXIST
    // is an FS race (concurrent unlink). Treat as not-stale so we don't try
    // to reclaim what someone else may have already taken.
    return false;
  }
}

function tryCreateLockFile(lockPath: string, stalenessMs: number): number | null {
  try {
    // O_CREAT | O_EXCL | O_WRONLY — succeeds only when the file does NOT
    // exist, which is the atomic primitive we need across concurrent callers.
    const fd = openSync(lockPath, "wx");
    const deadlineMs = Date.now() + stalenessMs;
    try {
      writeSync(fd, `${String(process.pid)}\t${new Date().toISOString()}\t${String(deadlineMs)}\n`);
    } catch {
      /* best-effort metadata; the file's existence is the lock */
    }
    return fd;
  } catch {
    return null;
  }
}

function makeLockHandle(fd: number, lockPath: string): PortLockHandle {
  let released = false;
  return {
    release: (): void => {
      if (released) return;
      released = true;
      try {
        closeSync(fd);
      } catch {
        /* fd already closed */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* unlink-after-close is racy on some FS; tolerate */
      }
    },
  };
}
