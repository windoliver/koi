/**
 * Layer 1 of §3.0: exclusive advisory lock on <dbPath>.lock.
 * Prevents two writer processes from opening the same store concurrently.
 * :memory: databases skip this since they're process-local by definition.
 *
 * Implementation uses O_CREAT | O_EXCL (exclusive-create) semantics. The
 * gap vs a proper flock is that a process killed with SIGKILL (no exit
 * handler) can leave a stale lock file. Plan 4 hardens this with a PID
 * liveness check or a proper flock binding.
 */

import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";

const LOCK_SUFFIX = ".lock";

function isInMemory(dbPath: string): boolean {
  return dbPath === ":memory:" || dbPath.startsWith("file::memory:");
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
      throw new Error("ArtifactStore already open by another process");
    }
    throw err;
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
