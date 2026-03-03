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

    // Write stdin if provided — Bun stdin is a FileSink
    if (hasStdin && proc.stdin !== undefined) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }

    // Timeout state must be mutable — set by setTimeout callback
    const timeoutMs = profile.resources.timeoutMs;
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill(9); // SIGKILL
      }, timeoutMs);
    }

    // Collect output
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
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
