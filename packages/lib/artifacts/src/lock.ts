/**
 * Layer 1 of §3.0: exclusive advisory lock on <dbPath>.lock.
 * Prevents two writer processes from opening the same store concurrently.
 * :memory: databases skip this since they're process-local by definition.
 *
 * Implementation uses O_CREAT | O_EXCL (exclusive-create) semantics, with a
 * PID-liveness check to recover from SIGKILL'd owners that couldn't run the
 * normal exit handler. A proper OS-backed flock is Plan 4's hardening — this
 * file-based approach is sufficient for single-host deployments.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const LOCK_SUFFIX = ".lock";

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

export function acquireLock(dbPath: string): () => void {
  if (isInMemory(dbPath)) {
    return () => {};
  }

  const lockPath = `${dbPath}${LOCK_SUFFIX}`;

  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      // Stale-lock recovery: if the recorded PID is dead, the previous owner
      // crashed without cleanup. Remove the stale lock and retry once.
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

  writeFileSync(fd, String(process.pid));

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      closeSync(fd);
    } catch {
      /* ignore close errors */
    }
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      /* ignore — another process may have already cleaned up */
    }
  };

  process.once("exit", release);

  return release;
}
