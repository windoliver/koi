/**
 * Per-directory write serialization for memory stores.
 *
 * Two coordinated layers:
 *
 *  1. In-process async mutex keyed by canonical directory path.
 *     Handles the common case (single agent, many concurrent tool calls).
 *     Zero FS overhead.
 *
 *  2. Cross-process file lock (`.memory.lock` in the directory, created
 *     with O_EXCL). The lockfile body is JSON `{ pid, host, nonce }`.
 *     Stale locks are only stolen after proving the owner is dead —
 *     `process.kill(pid, 0)` returning ESRCH on the same host.
 *     No mtime or lease heuristics.
 *
 * Locks are always released via `finally`. A release re-reads the lockfile
 * and verifies the nonce before unlinking — never deletes another owner's lock.
 *
 * NFS is explicitly unsupported: O_EXCL semantics are unreliable on some
 * NFS servers. This module assumes a local filesystem.
 */

import { randomBytes } from "node:crypto";
import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const LOCK_FILENAME = ".memory.lock";
/** Retry backoff for contended file locks (ms). */
const RETRY_DELAY_MS = 25;
/** Bound on file-lock acquisition time. */
const MAX_WAIT_MS = 10_000;

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly nonce: string;
}

// ---------------------------------------------------------------------------
// In-process mutex — module-level map keyed by canonical directory path
// ---------------------------------------------------------------------------

const inProcessChains = new Map<string, Promise<unknown>>();

/**
 * Serialize callbacks per canonical directory within the current process.
 *
 * The callback is invoked only after all previously queued callbacks for
 * the same key have settled (resolved or rejected). Returns the callback's
 * result.
 */
async function withInProcessMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = inProcessChains.get(key) ?? Promise.resolve();
  // Run `fn` after `prior` resolves OR rejects — next waiter only needs
  // the "done" signal, not the value, and must not inherit a rejection.
  const gated = prior.then(fn, fn);
  // The chain entry is a promise that never rejects, so a later caller
  // awaiting `prior` does not throw on a predecessor's failure.
  const nextChain = gated.catch((): undefined => undefined);
  inProcessChains.set(key, nextChain);
  try {
    return await gated;
  } finally {
    // Drop the entry only if we are still the tail — otherwise a later
    // caller has queued behind us and owns it now.
    if (inProcessChains.get(key) === nextChain) {
      inProcessChains.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-process file lock
// ---------------------------------------------------------------------------

function selfOwner(): LockOwner {
  return {
    pid: process.pid,
    host: hostname(),
    nonce: randomBytes(12).toString("hex"),
  };
}

function parseOwner(raw: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      "host" in parsed &&
      "nonce" in parsed &&
      typeof (parsed as Record<string, unknown>).pid === "number" &&
      typeof (parsed as Record<string, unknown>).host === "string" &&
      typeof (parsed as Record<string, unknown>).nonce === "string"
    ) {
      return parsed as LockOwner;
    }
  } catch {
    // Malformed lock file — treat as unknown owner (will not be stolen).
  }
  return undefined;
}

/**
 * Probe whether a PID is alive on this host.
 *
 * Returns `false` only when `process.kill(pid, 0)` throws `ESRCH`
 * (no such process). Any other outcome (EPERM, success) is conservative:
 * we assume the owner may still be alive.
 */
function isPidDeadOnThisHost(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return false; // Signal delivered — process exists.
  } catch (e: unknown) {
    if (typeof e === "object" && e !== null && "code" in e) {
      const code = (e as { readonly code: string }).code;
      if (code === "ESRCH") return true;
      // EPERM: process exists but we can't signal it — assume alive.
    }
    return false;
  }
}

/**
 * Attempt to steal a stale lock by atomically renaming it out of the way
 * and then `wx`-creating a fresh lock.
 *
 * Correctness rests on two atomic primitives:
 *
 *  1. `rename(lockPath, uniqueScratch)` — POSIX rename is atomic. If the
 *     source exists, exactly one caller removes it and moves it; all other
 *     racers get `ENOENT`. This is how competing stealers are serialized:
 *     only one process wins the right to clear the stale lock.
 *  2. `writeFile(lockPath, ..., { flag: "wx" })` — `O_EXCL` create is
 *     atomic. If a legitimate new owner raced in after we cleared the
 *     stale lock, the second create returns `EEXIST` and we back off.
 *
 * Together these rule out the "two winners" case: either we hold the
 * fresh lock (we won both primitives) or we return false (someone else
 * won one of them).
 */
async function stealStale(
  dir: string,
  expected: LockOwner,
  replacement: LockOwner,
): Promise<boolean> {
  const lockPath = join(dir, LOCK_FILENAME);
  const stolenPath = join(dir, `${LOCK_FILENAME}.stolen.${replacement.nonce}`);

  // Verify the current lock still belongs to the dead owner. This is a
  // TOCTOU hint, not a guarantee — the atomic rename below is what
  // actually serializes competing stealers.
  try {
    const current = parseOwner(await readFile(lockPath, "utf-8"));
    if (current === undefined || current.nonce !== expected.nonce) return false;
  } catch (e: unknown) {
    if (isEnoent(e)) return false;
    throw e;
  }

  // Atomic claim: rename the stale lock to a unique path keyed by our
  // nonce. If another stealer already renamed it, source is gone and we
  // get ENOENT.
  try {
    await rename(lockPath, stolenPath);
  } catch (e: unknown) {
    if (isEnoent(e)) return false;
    throw e;
  }

  // We own the stolen file — discard it — then `wx`-create the fresh
  // lock. If a legit writer raced in and created a new lock between our
  // rename and our create, wx yields EEXIST and we back off.
  await unlinkQuiet(stolenPath);
  try {
    await writeFile(lockPath, JSON.stringify(replacement), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch (e: unknown) {
    if (isEexist(e)) return false;
    throw e;
  }
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e: unknown) {
    if (!isEnoent(e)) throw e;
  }
}

/**
 * Acquire the directory file lock. Returns a release function.
 *
 * Behaviour:
 *  - Success: exclusive lock file created with this process's owner record.
 *  - Contention (EEXIST): wait briefly then retry. If the owner is on the
 *    same host and `process.kill(pid, 0)` reports ESRCH, steal atomically.
 *  - Gives up after MAX_WAIT_MS with a descriptive error.
 *
 * The returned release function is idempotent and only removes the lock
 * if its nonce still matches this owner's nonce (never steps on a steal).
 */
async function acquireFileLock(dir: string): Promise<() => Promise<void>> {
  const lockPath = join(dir, LOCK_FILENAME);
  const owner = selfOwner();
  const payload = JSON.stringify(owner);
  const start = Date.now();

  // let — retry loop
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    // Atomic create via write-temp + link: link() fails with EEXIST if
    // the target exists, so the lockfile is never observable in a
    // partially-written state. (writeFile + wx alone can leave a
    // truncated lockfile if the writer crashes between file creation
    // and the write of the payload.)
    const created = await tryAtomicCreate(dir, lockPath, payload, owner.nonce);
    if (created) return async () => releaseFileLock(lockPath, owner.nonce);

    // Contended — inspect the current holder.
    let currentOwner: LockOwner | undefined;
    let rawContent = "";
    try {
      rawContent = await readFile(lockPath, "utf-8");
      currentOwner = parseOwner(rawContent);
    } catch (readErr: unknown) {
      // Lock vanished between EEXIST and our read — retry creation immediately.
      if (isEnoent(readErr)) continue;
      throw readErr;
    }

    if (currentOwner !== undefined && isPidDeadOnThisHost(currentOwner)) {
      const stolen = await stealStale(dir, currentOwner, owner);
      if (stolen) {
        return async () => releaseFileLock(lockPath, owner.nonce);
      }
      // Someone else won the race; fall through to the backoff.
    } else if (currentOwner === undefined) {
      // Lockfile is unparseable — either pre-atomic-create writer crashed
      // mid-write, or the file was externally corrupted. Treat it as
      // stealable on the same rename-to-unique primitive used for dead
      // owners. The atomic rename guarantees at most one stealer wins,
      // and the subsequent wx-create guarantees we never displace a
      // legitimate live owner.
      const stolen = await stealCorrupted(dir, rawContent, owner);
      if (stolen) return async () => releaseFileLock(lockPath, owner.nonce);
    }

    if (Date.now() - start >= MAX_WAIT_MS) {
      const holder = currentOwner
        ? `pid=${String(currentOwner.pid)} host=${currentOwner.host}`
        : `unparseable lock at ${lockPath}`;
      throw new Error(
        `Timed out waiting for memory-fs lock after ${String(MAX_WAIT_MS)}ms; holder: ${holder}`,
      );
    }
    await sleep(RETRY_DELAY_MS);
  }
}

/**
 * Atomic exclusive create of the lock file.
 *
 * Writes the payload to a per-nonce temp file, then uses `link()` to
 * publish it at the target path. `link()` fails with EEXIST if the
 * target already exists, giving us the same exclusivity semantics as
 * `wx`, but the lockfile is only ever observable with its full payload
 * (never truncated mid-write).
 */
async function tryAtomicCreate(
  dir: string,
  lockPath: string,
  payload: string,
  nonce: string,
): Promise<boolean> {
  const tmpPath = join(dir, `${LOCK_FILENAME}.acquire.${nonce}.tmp`);
  await writeFile(tmpPath, payload, { encoding: "utf-8", flag: "wx" });
  try {
    await link(tmpPath, lockPath);
    return true;
  } catch (e: unknown) {
    if (isEexist(e)) return false;
    throw e;
  } finally {
    await unlinkQuiet(tmpPath);
  }
}

/**
 * Steal a lock whose contents did not parse as a valid owner record.
 * Uses the same atomic rename-to-unique + wx-create protocol as the
 * dead-owner path — at most one stealer wins, and the subsequent
 * wx-create cannot displace a fresh live owner.
 */
async function stealCorrupted(
  dir: string,
  rawContent: string,
  replacement: LockOwner,
): Promise<boolean> {
  const lockPath = join(dir, LOCK_FILENAME);
  const stolenPath = join(dir, `${LOCK_FILENAME}.corrupt.${replacement.nonce}`);

  // Verify the lockfile is still the one we just saw unparseable; if
  // another process already fixed it, defer.
  try {
    const current = await readFile(lockPath, "utf-8");
    if (current !== rawContent) return false;
    if (parseOwner(current) !== undefined) return false;
  } catch (e: unknown) {
    if (isEnoent(e)) return false;
    throw e;
  }

  try {
    await rename(lockPath, stolenPath);
  } catch (e: unknown) {
    if (isEnoent(e)) return false;
    throw e;
  }

  await unlinkQuiet(stolenPath);
  try {
    await writeFile(lockPath, JSON.stringify(replacement), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch (e: unknown) {
    if (isEexist(e)) return false;
    throw e;
  }
}

async function releaseFileLock(lockPath: string, nonce: string): Promise<void> {
  // Verify we still own the lock (nonce match) before unlinking.
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf-8");
  } catch (e: unknown) {
    if (isEnoent(e)) return;
    throw e;
  }
  const owner = parseOwner(raw);
  if (owner?.nonce !== nonce) return; // Someone else owns it now.
  await unlinkQuiet(lockPath);
}

// ---------------------------------------------------------------------------
// Public API — acquire both layers, return a release function
// ---------------------------------------------------------------------------

/**
 * Run `fn` under exclusive directory ownership: in-process mutex + file lock.
 * Acquires and releases both layers; the file lock is released before the
 * in-process mutex unwinds so that the next queued in-process waiter can
 * immediately acquire the file lock without ordering glitches.
 *
 * The critical section MUST stay tight — index rebuilds and other best-effort
 * work should happen outside.
 */
export async function withDirLock<T>(canonicalDir: string, fn: () => Promise<T>): Promise<T> {
  return withInProcessMutex(canonicalDir, async () => {
    const release = await acquireFileLock(canonicalDir);
    try {
      return await fn();
    } finally {
      await release();
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isEnoent(e: unknown): boolean {
  return hasErrCode(e, "ENOENT");
}

function isEexist(e: unknown): boolean {
  return hasErrCode(e, "EEXIST");
}

function hasErrCode(e: unknown, code: string): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { readonly code: string }).code === code
  );
}
