/**
 * Process lifecycle management: spawn, stream reading, graceful kill.
 *
 * Uses Bun.spawn() with Result-based error handling (never throws).
 */

import type { KoiError, Result } from "@koi/core";
import type { ManagedProcess, PipedProcess, PtyProcess, ShutdownConfig } from "./types.js";

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
): Result<PipedProcess, KoiError> {
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
        kind: "piped",
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
): Result<PipedProcess, KoiError> {
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
        kind: "piped",
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
// PTY spawn
// ---------------------------------------------------------------------------

/**
 * Spawn a child process with a pseudo-terminal (PTY) via Bun.Terminal.
 *
 * Output is delivered through the `onData` callback (Uint8Array chunks).
 * Unlike piped processes, stdin/stdout/stderr are not available — all I/O
 * goes through `proc.terminal`.
 */
export function spawnPtyProcess(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
  ptyConfig: { readonly cols: number; readonly rows: number },
  onData: (data: Uint8Array) => void,
): Result<PtyProcess, KoiError> {
  try {
    const proc = Bun.spawn([command, ...args], {
      cwd,
      env,
      terminal: {
        cols: ptyConfig.cols,
        rows: ptyConfig.rows,
        data(_terminal, data) {
          onData(data);
        },
      },
    });

    const terminal = proc.terminal;
    if (terminal === undefined) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `PTY terminal not available for "${command}" — ensure Bun >= 1.3.5 on a POSIX system`,
          retryable: false,
        },
      };
    }

    return {
      ok: true,
      value: {
        kind: "pty",
        pid: proc.pid,
        terminal: {
          write: (data: string | Uint8Array) => terminal.write(data),
          resize: (cols: number, rows: number) => terminal.resize(cols, rows),
          close: () => terminal.close(),
          get closed() {
            return terminal.closed;
          },
        },
        exited: proc.exited,
        kill: (signal?: number) => proc.kill(signal),
      },
    };
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Failed to spawn PTY process "${command}": ${e instanceof Error ? e.message : String(e)}`,
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

      const remaining = maxBytes - totalBytes;
      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        truncated = true;
        // Only emit the portion that fits within maxBytes (byte-accurate slice)
        if (remaining > 0) {
          const partial = value.subarray(0, remaining);
          const text = decoder.decode(partial, { stream: false });
          onChunk(text);
        }
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
 * Collect all descendant PIDs of a given PID recursively using `pgrep -P`.
 *
 * Returns PIDs in depth-first order (deepest descendants first) so callers
 * can signal leaves before parents, avoiding orphan re-parenting races.
 *
 * @internal Exported for testing.
 */
export function collectDescendants(pid: number): readonly number[] {
  const descendants: number[] = [];

  function walk(parentPid: number): void {
    try {
      const result = Bun.spawnSync(["pgrep", "-P", String(parentPid)], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const stdout =
        result.stdout instanceof Uint8Array
          ? new TextDecoder().decode(result.stdout)
          : typeof result.stdout === "string"
            ? result.stdout
            : "";
      const childPids = stdout
        .trim()
        .split("\n")
        .map((s) => parseInt(s, 10))
        .filter((n) => !Number.isNaN(n) && n > 0);

      for (const childPid of childPids) {
        // Recurse first so deepest descendants come first (leaf-to-root order)
        walk(childPid);
        descendants.push(childPid);
      }
    } catch {
      // pgrep unavailable or no children — not fatal
    }
  }

  walk(pid);
  return descendants;
}

/**
 * Kill a process and all its descendants (process tree kill).
 *
 * Uses three strategies in sequence (belt-and-suspenders):
 * 1. `kill(-pid)` — process-group signal. Works when process is a group
 *    leader, catches all descendants in one syscall.
 * 2. Recursive descendant collection via `pgrep -P` — signals every
 *    descendant (children, grandchildren, etc.) leaf-first.
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

  // 2. Signal all descendants recursively (leaf-first to avoid orphan races)
  const descendants = collectDescendants(pid);
  for (const childPid of descendants) {
    try {
      process.kill(childPid, signal);
    } catch {
      // Descendant may have already exited — expected
    }
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

  // Close PTY terminal if applicable (sends EOF to subprocess)
  if (proc.kind === "pty" && !proc.terminal.closed) {
    proc.terminal.close();
  }

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
