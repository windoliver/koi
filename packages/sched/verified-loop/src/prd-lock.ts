/**
 * Advisory file-lock for the PRD coordinator.
 *
 * See `prd-store.ts` for the locking contract. The lock is an O_EXCL
 * sidecar `<prdPath>.lock` whose ownership is verified by:
 *   - an unguessable owner token written into the file
 *   - the inode captured at acquire time (compared against stat() on
 *     refresh/release) so a successor that unlinks + recreates the
 *     path does not get its lock corrupted by our writes.
 */

import { type FileHandle, open, readFile, stat, unlink } from "node:fs/promises";
import type { KoiError, Result } from "@koi/core";
import { conflict, internal } from "@koi/core";
import { extractMessage } from "@koi/errors";

/**
 * Handle returned by acquirePRDLock; pass to releasePRDLock to release
 * or to refreshPRDLock to extend the heartbeat.
 *
 * Carries:
 *   - `owner`: unguessable token. releasePRDLock / refreshPRDLock
 *     compare it against the on-disk lock content before mutating.
 *   - `handle`: the open FileHandle from acquire-time. Refresh writes
 *     via this handle (truncate + write) so its updates always go to
 *     the original inode. If a successor coordinator unlinks the
 *     lockfile and creates a new one at the same path, our writes
 *     still target the original (now orphaned) inode and never
 *     overwrite the successor's lock content. Combined with an
 *     inode-equality check (stat(path).ino vs fstat(handle).ino)
 *     this gives us race-free ownership detection without needing
 *     flock or renameat2.
 *   - `inode`: original inode number captured at acquire time.
 */
export interface PRDLock {
  readonly path: string;
  readonly owner: string;
  readonly handle: FileHandle;
  readonly inode: number;
}

/**
 * A lock is considered stale when its heartbeat is older than this
 * threshold. Must be greater than the longest expected pause between
 * heartbeats (the orchestrator refreshes per iteration; default
 * iteration timeout is 10 min, so we allow 15 min slack).
 */
const HEARTBEAT_STALE_MS = 15 * 60_000;

interface ParsedLockMeta {
  heartbeatAt?: unknown;
  pid?: unknown;
  released?: unknown;
}

/**
 * Acquire an advisory lock on the PRD path. Creates `<prdPath>.lock`
 * with O_EXCL containing the holder's PID, host, owner token, and
 * heartbeat timestamp. Returns CONFLICT if a *live* coordinator
 * already holds it.
 *
 * Stale detection is heartbeat-based, not PID-based: a lock is broken
 * when heartbeat age exceeds HEARTBEAT_STALE_MS. PID liveness alone is
 * unreliable for crash recovery because the dead coordinator's PID can
 * be reused by an unrelated process before the next run, making a
 * stale lock indistinguishable from a live one. Heartbeat freshness
 * cannot be forged by PID reuse: only the owning run() invocation
 * (which holds refreshPRDLock via the owner token) can update it.
 *
 * The orchestrator must call refreshPRDLock at least every
 * HEARTBEAT_STALE_MS ms during a long run; the default cadence is
 * once per iteration.
 *
 * Lock is process-local: it does NOT survive across hosts. For
 * cross-host exclusion the deployment must front this with a
 * distributed lease.
 */
export async function acquirePRDLock(prdPath: string): Promise<Result<PRDLock, KoiError>> {
  const lockPath = `${prdPath}.lock`;
  const owner = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  // Use let — justified: retry once after breaking a stale lock.
  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    const acquired = await tryCreateLock(lockPath, owner);
    if (acquired.ok) return acquired;
    if (acquired.error.code !== "CONFLICT") return acquired;
    const stale = await isLockStale(lockPath);
    if (!stale) {
      return {
        ok: false,
        error: conflict(
          lockPath,
          `PRD is locked by another live coordinator (lockfile: ${lockPath}). Stop the other process or wait for it to exit.`,
        ),
      };
    }
    // Break the stale lock and retry once.
    await unlink(lockPath).catch(() => undefined);
  }
  return {
    ok: false,
    error: internal(`Failed to acquire PRD lock at ${lockPath} after breaking stale holder`),
  };
}

async function tryCreateLock(lockPath: string, owner: string): Promise<Result<PRDLock, KoiError>> {
  // Use let — justified: assigned in try, used after for cleanup-on-error.
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, "wx");
    const now = new Date().toISOString();
    const payload = JSON.stringify({
      pid: process.pid,
      host: process.env.HOSTNAME ?? "unknown",
      owner,
      acquiredAt: now,
      heartbeatAt: now,
    });
    await handle.writeFile(payload);
    await handle.sync();
    // Capture inode for later identity checks. fstat returns the
    // inode of the file referenced by the handle, which stays the
    // same even if another process unlinks/replaces the path.
    const st = await handle.stat();
    const inode = st.ino;
    // Hold the handle open for the lock lifetime; releasePRDLock
    // closes it. Do NOT close here.
    return { ok: true, value: { path: lockPath, owner, handle, inode } };
  } catch (e: unknown) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    const code = (e as { readonly code?: unknown }).code;
    if (code === "EEXIST") {
      return { ok: false, error: conflict(lockPath, `Lock exists at ${lockPath}`) };
    }
    return {
      ok: false,
      error: internal(`Failed to acquire PRD lock at ${lockPath}: ${extractMessage(e)}`, e),
    };
  }
}

/**
 * Decide whether an existing lockfile may be safely broken. Only break a
 * lock on POSITIVE evidence: a parsed heartbeat older than
 * HEARTBEAT_STALE_MS, OR a parsed PID we can prove is dead. Transient
 * readFile failures, partial reads on flaky storage, permission problems,
 * and unparseable JSON are NOT permission to steal the lock — that would
 * let one transient I/O error allow a second coordinator to start while
 * the first is still healthy. On any read/parse failure, conservatively
 * treat the lock as live and refuse acquisition; the operator can manually
 * delete a genuinely corrupt lockfile.
 */
async function isLockStale(lockPath: string): Promise<boolean> {
  // Lock exists. Break it when:
  //   - lock file is unparseable AND mtime is older than stale window, OR
  //   - heartbeat is older than HEARTBEAT_STALE_MS, OR
  //   - holder PID is provably dead (ESRCH), OR
  //   - prior owner wrote `released:true` sentinel.
  // Heartbeat freshness is the primary source of truth — only the
  // legitimate owner can update heartbeatAt (refreshPRDLock checks
  // the owner token), so PID reuse cannot forge it. The PID-dead
  // path exists as a fast-recovery hint: if we can prove the
  // holder is gone, we don't need to wait for heartbeat staleness.
  // Use let — justified: assigned across try/catch.
  let parsedMeta: ParsedLockMeta | undefined;
  try {
    const raw = await readFile(lockPath, "utf8");
    parsedMeta = JSON.parse(raw) as ParsedLockMeta;
  } catch {
    // Unreadable / corrupt lock file. Two cases to distinguish:
    //   1. Transient I/O (flaky storage, partial read) — must NOT
    //      steal a healthy live lock.
    //   2. Crash mid-refresh left a torn/empty payload — without
    //      breaking, the loop is permanently wedged.
    // Use the file's mtime as a tiebreaker: if mtime is older than
    // the heartbeat staleness window, no one has been writing it
    // recently, so it is safe to assume the holder is dead and
    // break. mtime is updated by both truncate() and write(), so
    // a healthy refresh always bumps it.
    return await mtimeIndicatesStale(lockPath);
  }
  return metaIndicatesStale(parsedMeta);
}

async function mtimeIndicatesStale(lockPath: string): Promise<boolean> {
  try {
    const fileStat = await stat(lockPath);
    const mtimeAgeMs = Date.now() - fileStat.mtimeMs;
    return mtimeAgeMs > HEARTBEAT_STALE_MS;
  } catch {
    // Even stat failed — leave stale=false to avoid stealing.
    return false;
  }
}

function metaIndicatesStale(parsedMeta: ParsedLockMeta): boolean {
  // Released sentinel from a prior owner's normal exit. Safe to
  // break and recreate — the prior owner has already given up
  // the lock and pointed us at it.
  if (parsedMeta.released === true) return true;
  const heartbeatMs =
    typeof parsedMeta.heartbeatAt === "string" ? Date.parse(parsedMeta.heartbeatAt) : Number.NaN;
  if (Number.isFinite(heartbeatMs)) {
    const ageMs = Date.now() - heartbeatMs;
    if (ageMs > HEARTBEAT_STALE_MS) return true;
  }
  // Fast-path: if PID is provably dead, break immediately even
  // if the heartbeat is fresh (the holder couldn't have updated
  // it). EPERM means the process exists under a different uid —
  // do NOT treat as dead. ESRCH = no such process.
  if (typeof parsedMeta.pid === "number") {
    try {
      process.kill(parsedMeta.pid, 0);
    } catch (probeErr: unknown) {
      const probeCode = (probeErr as { readonly code?: unknown }).code;
      if (probeCode === "ESRCH") return true;
    }
  }
  return false;
}

/**
 * Refresh the heartbeat of a held lock. Inode-anchored and race-free
 * with respect to a successor coordinator stealing the lockfile path:
 *
 *   1. fstat the held FileHandle and stat() the lockfile path.
 *      If their inodes differ, the path now points at someone else's
 *      lockfile (stale-break + reacquire happened) — return false.
 *   2. Truncate and rewrite the lockfile via the held handle. Writes
 *      always target the original inode. If the path was unlinked and
 *      a successor created a new file at the same path, our writes
 *      go to the orphaned inode and never touch the successor's lock.
 *   3. Re-stat to confirm the inode hasn't changed during the write.
 *
 * Returns false on:
 *   - inode mismatch at any check (lock was stolen)
 *   - any I/O failure
 *
 * This avoids the read-then-rename TOCTOU window that bytes-only
 * approaches have, without requiring renameat2/flock (neither is
 * portable across Bun on macOS).
 */
export async function refreshPRDLock(lock: PRDLock): Promise<boolean> {
  // Pre-check: does the path still point at our inode?
  if (!(await inodeMatches(lock))) return false;
  // Build the refreshed payload. We don't need to preserve unknown
  // fields here because we wrote the file ourselves at acquire-time
  // and the heartbeat-only update is bounded.
  const payload = JSON.stringify({
    pid: process.pid,
    host: process.env.HOSTNAME ?? "unknown",
    owner: lock.owner,
    heartbeatAt: new Date().toISOString(),
  });
  try {
    await lock.handle.truncate(0);
    // pwrite at offset 0 to avoid relying on internal cursor position.
    await lock.handle.write(payload, 0, "utf8");
  } catch {
    return false;
  }
  // Post-check: confirm the path still resolves to our inode. If a
  // successor unlinked + recreated between the pre-check and now,
  // this catches it. The successor's lock is untouched (our writes
  // went to the original, now-orphaned inode).
  return await inodeMatches(lock);
}

async function inodeMatches(lock: PRDLock): Promise<boolean> {
  try {
    const pathStat = await stat(lock.path);
    return pathStat.ino === lock.inode;
  } catch {
    return false;
  }
}

/**
 * Release a lock previously acquired by acquirePRDLock. Race-free with
 * respect to a successor coordinator stealing the lockfile path:
 * writes a `released: true` sentinel into the file via the held
 * FileHandle (truncate + pwrite, atomic-ish) and closes the handle.
 *
 * The sentinel content goes to our original inode. If a successor
 * unlinked our lock and created a new one at the same path, our
 * write targets the orphaned inode and never touches theirs — so we
 * can never accidentally release someone else's live lock.
 *
 * acquirePRDLock treats a `released:true` payload at the path as
 * stale and breaks it on the next attempt, so a normal lifecycle
 * is: acquire → ... → release-with-sentinel → next acquire breaks
 * the released file and takes over.
 *
 * Idempotent: handles already-closed/released locks safely.
 */
export async function releasePRDLock(lock: PRDLock): Promise<void> {
  // Inode-checked path unlink is the simplest race-free release: it
  // is one atomic syscall against an inode we own. We do this FIRST
  // (before any heartbeat or sentinel write that could be torn by a
  // crash mid-write) so a crash during release leaves either:
  //   (a) our lock fully present (acquirer sees it as live, but our
  //       PID is dead → fast-path stale break, OR
  //       heartbeat will eventually go stale), OR
  //   (b) our lock cleanly gone (acquirer's O_EXCL wins immediately).
  // What we MUST avoid: a torn empty/corrupt lockfile, which would
  // make acquirer wait the full HEARTBEAT_STALE_MS (mtime tiebreaker)
  // before recovering — a 15-min outage from a normal crash.
  try {
    const pathStat = await stat(lock.path);
    if (pathStat.ino === lock.inode) {
      await unlink(lock.path).catch(() => undefined);
    }
  } catch {
    // Path missing — already released or never existed.
  }
  await lock.handle.close().catch(() => undefined);
}
