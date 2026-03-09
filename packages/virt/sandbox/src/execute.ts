/**
 * execute() — Buffered sandbox execution API.
 * Runs a command in a sandboxed process and collects output.
 */

import type { KoiError, Result } from "@koi/core";
import { createSandboxCommand } from "./command.js";
import type { SandboxAdapterResult, SandboxProfile } from "./types.js";

/** Default max output bytes: 10 MB. */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface ExecuteOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  /** Override profile timeout. Takes precedence over profile.resources.timeoutMs. */
  readonly timeoutMs?: number;
  /** Streaming callback for stdout chunks. */
  readonly onStdout?: (chunk: string) => void;
  /** Streaming callback for stderr chunks. */
  readonly onStderr?: (chunk: string) => void;
  /** Maximum bytes to capture for stdout+stderr. Default: 10 MB. */
  readonly maxOutputBytes?: number;
  /** Abort signal — kills the process when aborted. */
  readonly signal?: AbortSignal;
}

export async function execute(
  profile: SandboxProfile,
  command: string,
  args: readonly string[],
  options?: ExecuteOptions,
): Promise<Result<SandboxAdapterResult, KoiError>> {
  const cmd = createSandboxCommand(profile, command, args);
  if (!cmd.ok) {
    return cmd;
  }

  const { executable, args: execArgs } = cmd.value;
  const startTime = performance.now();
  const hasStdin = options?.stdin !== undefined;

  // Early exit if already aborted
  if (options?.signal?.aborted) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: "Execution aborted before start",
        retryable: false,
      },
    };
  }

  try {
    const spawnOpts: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin: "pipe" | "ignore";
      stdout: "pipe";
      stderr: "pipe";
    } = {
      stdin: hasStdin ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    };
    if (options?.cwd !== undefined) {
      spawnOpts.cwd = options.cwd;
    }
    if (options?.env !== undefined) {
      spawnOpts.env = options.env as Record<string, string | undefined>;
    }

    const proc = Bun.spawn([executable, ...execArgs], spawnOpts);

    // Wire abort signal to kill the process
    if (options?.signal !== undefined) {
      options.signal.addEventListener(
        "abort",
        () => {
          proc.kill(9);
        },
        { once: true },
      );
    }

    // Write stdin if provided — Bun stdin is a FileSink
    if (hasStdin && proc.stdin !== undefined) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }

    // Timeout state must be mutable — set by setTimeout callback
    const timeoutMs = options?.timeoutMs ?? profile.resources.timeoutMs;
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill(9); // SIGKILL
      }, timeoutMs);
    }

    // Collect output — streaming if callbacks provided, buffered otherwise.
    // Enforce maxOutputBytes to prevent OOM from large process output.
    const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const [stdoutCollected, stderrCollected, exitCode] = await Promise.all([
      collectStream(proc.stdout, maxOutputBytes, options?.onStdout),
      collectStream(proc.stderr, maxOutputBytes, options?.onStderr),
      proc.exited,
    ]);
    const stdout = stdoutCollected.text;
    const stderr = stderrCollected.text;
    const truncated = stdoutCollected.truncated || stderrCollected.truncated;

    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    const durationMs = performance.now() - startTime;

    // Exit codes > 128 indicate signal termination (128 + signal number).
    // 137 = 128 + 9 (SIGKILL) without timeout indicates OOM kill.
    const oomKilled = !timedOut && exitCode === 137;
    const signalNum = exitCode > 128 ? signalName(exitCode - 128) : null;

    const result: SandboxAdapterResult =
      signalNum !== null
        ? { exitCode, stdout, stderr, signal: signalNum, durationMs, timedOut, oomKilled, ...(truncated ? { truncated } : {}) }
        : { exitCode, stdout, stderr, durationMs, timedOut, oomKilled, ...(truncated ? { truncated } : {}) };

    return { ok: true, value: result };
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Sandbox execution failed: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
        retryable: false,
      },
    };
  }
}

interface CollectedStream {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Collect a ReadableStream<Uint8Array> into a string with a byte limit.
 * Optionally calls a callback for each decoded chunk.
 */
async function collectStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onChunk?: (chunk: string) => void,
): Promise<CollectedStream> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  // Justified `let`: accumulated byte count + truncation flag
  let totalBytes = 0;
  let truncated = false;

  for await (const bytes of stream) {
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) {
      truncated = true;
      // Stop accumulating but keep draining to avoid backpressure deadlock
      continue;
    }

    const text = decoder.decode(bytes, { stream: true });
    if (text.length > 0) {
      chunks.push(text);
      onChunk?.(text);
    }
  }

  // Flush any remaining bytes in the decoder
  if (!truncated) {
    const final = decoder.decode();
    if (final.length > 0) {
      chunks.push(final);
      onChunk?.(final);
    }
  }

  return { text: chunks.join(""), truncated };
}

function signalName(signalNum: number): string | null {
  const signals: Readonly<Record<number, string>> = {
    1: "SIGHUP",
    2: "SIGINT",
    3: "SIGQUIT",
    6: "SIGABRT",
    9: "SIGKILL",
    11: "SIGSEGV",
    13: "SIGPIPE",
    14: "SIGALRM",
    15: "SIGTERM",
  };
  return signals[signalNum] ?? null;
}
