/**
 * execute() — Buffered sandbox execution API.
 * Runs a command in a sandboxed process and collects output.
 */

import type { KoiError, Result } from "@koi/core";
import { createSandboxCommand } from "./command.js";
import type { SandboxAdapterResult, SandboxProfile } from "./types.js";

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

    // Collect output — streaming if callbacks provided, buffered otherwise
    const [stdout, stderr, exitCode] = await Promise.all([
      collectStream(proc.stdout, options?.onStdout),
      collectStream(proc.stderr, options?.onStderr),
      proc.exited,
    ]);

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
        ? { exitCode, stdout, stderr, signal: signalNum, durationMs, timedOut, oomKilled }
        : { exitCode, stdout, stderr, durationMs, timedOut, oomKilled };

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

/**
 * Collect a ReadableStream<Uint8Array> into a string, optionally calling
 * a callback for each decoded chunk. Uses the fast Response.text() path
 * when no callback is needed.
 */
async function collectStream(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  if (onChunk === undefined) {
    return new Response(stream).text();
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];

  for await (const bytes of stream) {
    const text = decoder.decode(bytes, { stream: true });
    if (text.length > 0) {
      chunks.push(text);
      onChunk(text);
    }
  }

  // Flush any remaining bytes in the decoder
  const final = decoder.decode();
  if (final.length > 0) {
    chunks.push(final);
    onChunk(final);
  }

  return chunks.join("");
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
