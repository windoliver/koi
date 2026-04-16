/**
 * Shared bash execution helpers.
 *
 * Extracted so both the foreground Bash tool and the background bash_background
 * tool share the same spawn/drain logic without code duplication.
 *
 * NOT part of the public API — import from the package entry-point only for
 * public types. These are package-internal exports.
 */

import { spawn as spawnChild } from "node:child_process";
import { Readable } from "node:stream";
import type { SandboxAdapter, SandboxProfile } from "@koi/core";

/** Grace period before escalating SIGTERM to SIGKILL on cancellation. */
export const SIGKILL_ESCALATION_MS = 3_000;

/** Safe minimal environment for spawned bash processes. */
export const SAFE_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "dumb",
} as const;

/**
 * Build a safe env with additional PATH directories prepended.
 *
 * Each entry in `pathExtensions` is prepended to the default PATH so
 * user-installed tools (bun, node, python, brew) are discoverable
 * without leaking the full parent environment.
 */
/**
 * Options for building a customized safe environment.
 */
export interface SafeEnvOptions {
  /** Additional PATH directories prepended to the default PATH. */
  readonly pathExtensions?: readonly string[] | undefined;
  /**
   * Validated home directory to use instead of `process.env.HOME`.
   * When provided, overrides the default HOME in the spawned env.
   * Use when the caller has verified home directory ownership.
   */
  readonly home?: string | undefined;
}

export function buildSafeEnv(options: SafeEnvOptions): Readonly<Record<string, string>> {
  const pathExtensions = options.pathExtensions ?? [];
  const home = options.home;
  const hasHome = home !== undefined;

  // Reject entries that are empty, non-absolute, or contain ":" (which
  // would inject extra PATH segments). Empty segments mean "search cwd"
  // in POSIX PATH, enabling repo-local command hijacking.
  const safe = pathExtensions.filter((p) => p.length > 0 && p.startsWith("/") && !p.includes(":"));
  if (safe.length === 0 && !hasHome) return SAFE_ENV;

  const basePath = SAFE_ENV.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const path = safe.length > 0 ? [...safe, basePath].join(":") : basePath;

  return {
    ...SAFE_ENV,
    PATH: path,
    HOME: hasHome ? home : (SAFE_ENV.HOME ?? "/tmp"),
  };
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly truncatedNote?: string;
}

interface DrainResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly byteCount: number;
}

/**
 * Drain a ReadableStream into a string, respecting a shared byte budget.
 * Keeps draining after budget is exhausted to prevent pipe-buffer deadlock.
 */
export async function drainStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  budget: { remaining: number },
): Promise<DrainResult> {
  if (stream == null) return { text: "", truncated: false, byteCount: 0 };

  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  let truncated = false;
  let byteCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.length;

      if (budget.remaining <= 0) {
        // Budget exhausted — keep draining to unblock subprocess writes
        truncated = true;
        continue;
      }

      const chunk = value.length <= budget.remaining ? value : value.slice(0, budget.remaining);
      text += decoder.decode(chunk, { stream: true });
      budget.remaining -= chunk.length;

      if (value.length > chunk.length) {
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text, truncated, byteCount };
}

/**
 * Execute a bash command inside an OS sandbox via SandboxInstance.exec().
 *
 * The caller is responsible for prepending `set -euo pipefail\n` to `command`
 * if desired (the exec helper does not modify the command string).
 */
export async function execSandboxed(
  adapter: SandboxAdapter,
  profile: SandboxProfile,
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
  env: Readonly<Record<string, string>> = SAFE_ENV,
): Promise<ExecResult> {
  const start = Date.now();
  const instance = await adapter.create(profile);
  try {
    const r = await instance.exec("bash", ["--noprofile", "--norc", "-c", command], {
      cwd,
      env,
      timeoutMs,
      maxOutputBytes,
      ...(signal !== undefined ? { signal } : {}),
    });
    const truncated = r.truncated === true;
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: Date.now() - start,
      timedOut: r.timedOut ?? false,
      truncated,
      ...(truncated ? { truncatedNote: `Output truncated at ${maxOutputBytes} bytes` } : {}),
    };
  } finally {
    await instance.destroy();
  }
}

/**
 * Spawn bash and collect output with AbortSignal support and output budgeting.
 *
 * The caller is responsible for the full `command` string — this helper does NOT
 * prepend `set -euo pipefail`. See `createBashTool` for the assembly pattern.
 *
 * Process group kill: `detached: true` puts bash in its own process group so
 * that `process.kill(-pid, signal)` terminates bash AND all descendants.
 */
export async function spawnBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
  env: Readonly<Record<string, string>> = SAFE_ENV,
): Promise<ExecResult> {
  const start = Date.now();

  // Build effective signal: combine caller signal + per-invocation timeout
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);

  const signals: AbortSignal[] = [timeoutController.signal];
  if (signal !== undefined) signals.push(signal);
  const effectiveSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  // Re-check after building signal — avoid spawn if already aborted
  if (effectiveSignal?.aborted) {
    clearTimeout(timer);
    signal?.throwIfAborted();
    return {
      stdout: "",
      stderr: "Operation cancelled before spawn",
      exitCode: 1,
      durationMs: 0,
      timedOut: false,
      truncated: false,
    };
  }

  // detached: true (Unix) — bash starts as the leader of a new process group.
  // PGID == proc.pid, so `process.kill(-pid, sig)` kills every descendant.
  const proc = spawnChild("bash", ["--noprofile", "--norc", "-c", command], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env,
    detached: true,
  });

  // Convert Node.js Readable to Web ReadableStream for drainStream
  const stdoutStream: ReadableStream<Uint8Array> | null =
    proc.stdout !== null ? (Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>) : null;
  const stderrStream: ReadableStream<Uint8Array> | null =
    proc.stderr !== null ? (Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>) : null;

  // Wire abort — kill the entire process group, not just the shell
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    const pid = proc.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGTERM"); // Negative PID targets the process group
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    killTimer = setTimeout(() => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already exited
        }
      }
    }, SIGKILL_ESCALATION_MS);
  };
  effectiveSignal?.addEventListener("abort", onAbort, { once: true });

  // Guard against race: signal aborted between check and addEventListener
  if (effectiveSignal?.aborted) {
    onAbort();
  }

  // Collect stdout and stderr with a shared byte budget.
  // Both streams are drained concurrently to prevent pipe-buffer deadlock.
  const budget = { remaining: maxOutputBytes };
  let spawnError: Error | undefined;
  const exited = new Promise<number>((resolve) => {
    proc.on("exit", (code) => resolve(code ?? 1));
    proc.on("error", (err: Error) => {
      spawnError = err;
      resolve(1);
    });
  });
  const [stdoutResult, stderrResult] = await Promise.all([
    drainStream(stdoutStream, budget),
    drainStream(stderrStream, budget),
  ]);
  const exitCode = await exited;

  // Cleanup
  effectiveSignal?.removeEventListener("abort", onAbort);
  clearTimeout(timer);
  if (killTimer !== undefined) clearTimeout(killTimer);

  if (spawnError !== undefined) {
    return {
      stdout: "",
      stderr: spawnError.message,
      exitCode: 1,
      durationMs: Date.now() - start,
      timedOut: false,
      truncated: false,
    };
  }

  const truncated = stdoutResult.truncated || stderrResult.truncated;
  const totalBytes = stdoutResult.byteCount + stderrResult.byteCount;

  return {
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    exitCode,
    durationMs: Date.now() - start,
    timedOut,
    truncated,
    ...(truncated
      ? { truncatedNote: `Output truncated at ${maxOutputBytes} bytes (${totalBytes} bytes total)` }
      : {}),
  };
}
