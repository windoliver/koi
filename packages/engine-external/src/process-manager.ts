/**
 * Process lifecycle management: spawn, stream reading, graceful kill.
 *
 * Uses Bun.spawn() with Result-based error handling (never throws).
 */

import type { KoiError, Result } from "@koi/core";
import type { ManagedProcess, ShutdownConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SIGNAL = 15 as const; // SIGTERM
const DEFAULT_GRACE_PERIOD_MS = 5_000 as const;
const SIGKILL = 9 as const;

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * Spawn a child process with piped stdin/stdout/stderr. Returns a Result.
 *
 * On EBADF (file descriptor exhaustion), retries once with `stdin: "ignore"`
 * to recover gracefully (mirrors OpenClaw's spawnWithFallback pattern).
 */
export function spawnProcess(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
): Result<ManagedProcess, KoiError> {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env,
    });

    return {
      ok: true,
      value: {
        pid: proc.pid,
        stdin: proc.stdin,
        stdout: proc.stdout as ReadableStream<Uint8Array>,
        stderr: proc.stderr as ReadableStream<Uint8Array>,
        exited: proc.exited,
        kill: (signal?: number) => proc.kill(signal),
      },
    };
  } catch (e: unknown) {
    // Retry once on EBADF (file descriptor exhaustion) with stdin: "ignore"
    if (isEbadf(e)) {
      return spawnFallback(command, args, env, cwd);
    }
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Failed to spawn process "${command}": ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
        retryable: false,
      },
    };
  }
}

/** @internal Exported for testing. */
export function isEbadf(e: unknown): boolean {
  if (e instanceof Error) {
    return e.message.includes("EBADF") || (e as NodeJS.ErrnoException).code === "EBADF";
  }
  return false;
}

/** @internal Fallback spawn with stdin disabled — used on EBADF retry. Exported for testing. */
export function spawnFallback(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
): Result<ManagedProcess, KoiError> {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env,
    });

    // Provide a no-op stdin since the real one is unavailable
    const noopStdin = {
      write(_data: string | Uint8Array): number {
        return 0;
      },
      end(): void {
        /* no-op */
      },
    };

    return {
      ok: true,
      value: {
        pid: proc.pid,
        stdin: noopStdin,
        stdout: proc.stdout as ReadableStream<Uint8Array>,
        stderr: proc.stderr as ReadableStream<Uint8Array>,
        exited: proc.exited,
        kill: (signal?: number) => proc.kill(signal),
      },
    };
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Failed to spawn process "${command}" (EBADF retry): ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
        retryable: false,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Stream reading
// ---------------------------------------------------------------------------

/**
 * Read a stream chunk-by-chunk, decoding to text. Calls `onChunk` for each
 * decoded text segment. Stops after `maxBytes` total have been read and
 * calls `onChunk` with a truncation marker.
 *
 * Respects an optional AbortSignal for cancellation.
 */
export async function readStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  // let: tracks total bytes read for backpressure
  let totalBytes = 0;
  // let: set once when truncation is reached
  let truncated = false;

  const reader = stream.getReader();
  try {
    while (true) {
      if (signal?.aborted === true) break;

      const { done, value } = await reader.read();
      if (done) break;

      // After truncation, keep draining to prevent pipe backup (process would
      // block on write if the pipe fills), but don't call onChunk.
      if (truncated) continue;

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        truncated = true;
        const text = decoder.decode(value, { stream: false });
        onChunk(text);
        onChunk("\n[output truncated]");
        continue; // keep draining
      }

      const text = decoder.decode(value, { stream: true });
      onChunk(text);
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Graceful kill
// ---------------------------------------------------------------------------

/**
 * Kill a process and all its descendants (process tree kill).
 *
 * Uses three strategies in sequence (belt-and-suspenders):
 * 1. `kill(-pid)` — process-group signal. Works when process is a group
 *    leader, catches all descendants in one syscall.
 * 2. `pkill -P` — signals direct children by parent PID. Catches the
 *    common case where Bun.spawn() children inherit the parent's group.
 * 3. `kill(pid)` — direct signal to the process itself.
 *
 * Redundant signals to already-dead processes are harmless (ESRCH).
 */
function killTree(pid: number, signal: number): void {
  // 1. Process-group kill (catches all descendants if pid is group leader)
  try {
    process.kill(-pid, signal);
  } catch {
    // Not a process group leader or already exited — expected
  }

  // 2. Signal direct children via pkill (catches non-group-leader case)
  try {
    Bun.spawnSync(["pkill", `-${signal}`, "-P", String(pid)], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // pkill unavailable or no children — not fatal
  }

  // 3. Signal the process directly
  try {
    process.kill(pid, signal);
  } catch {
    // Process may have already exited
  }
}

/**
 * Gracefully kill a process tree: signal children + parent, wait grace
 * period, then SIGKILL the tree. Returns the exit code.
 */
export async function killProcess(
  proc: ManagedProcess,
  shutdown?: ShutdownConfig,
): Promise<number> {
  const signal = shutdown?.signal ?? DEFAULT_SIGNAL;
  const gracePeriodMs = shutdown?.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;

  killTree(proc.pid, signal);

  // let: timer handle — must be cleared to avoid leak when process exits before grace period
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    proc.exited,
    new Promise<"timeout">((resolve) => {
      graceTimer = setTimeout(() => resolve("timeout"), gracePeriodMs);
    }),
  ]);

  if (graceTimer !== undefined) clearTimeout(graceTimer);

  if (result === "timeout") {
    killTree(proc.pid, SIGKILL);
    return proc.exited;
  }

  return result;
}
