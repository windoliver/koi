import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KoiError, Result } from "@koi/core";

export interface LockHandle {
  readonly path: string;
  readonly pid: number;
}

export function acquireLock(path: string): Result<LockHandle, KoiError> {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8").trim();
    const otherPid = Number(text);
    if (Number.isInteger(otherPid) && isPidAlive(otherPid)) {
      return {
        ok: false,
        error: {
          code: "ALREADY_RUNNING",
          message: `Gateway already running on this host (PID ${otherPid})`,
          retryable: false,
          context: { pid: otherPid, lockPath: path },
        },
      };
    }
    try {
      unlinkSync(path);
    } catch (err: unknown) {
      // Best-effort stale-lock cleanup; if unlink races with another reclaimer
      // the subsequent writeFileSync(flag: "wx") will surface the conflict as
      // ALREADY_RUNNING, which is the correct typed error.
      void err;
    }
  }
  const pid = process.pid;
  try {
    writeFileSync(path, String(pid), { flag: "wx" });
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "ALREADY_RUNNING",
        message: "Failed to acquire lock",
        retryable: false,
        cause: err,
        context: { lockPath: path },
      },
    };
  }
  return { ok: true, value: { path, pid } };
}

export function releaseLock(path: string, handle: LockHandle): void {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (text === String(handle.pid)) unlinkSync(path);
  } catch (err: unknown) {
    // Best-effort cleanup; lock release failure should never propagate to the
    // shutdown path. The lock will be reclaimed on next start via stale-PID detection.
    void err;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // ESRCH (no such process) or EPERM (exists but inaccessible) — treat as
    // not-alive-by-us; either way the lock is reclaimable.
    void err;
    return false;
  }
}
