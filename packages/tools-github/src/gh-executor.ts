/**
 * GhExecutor — interface + factory for running `gh` CLI commands.
 *
 * The interface enables mock injection in tests while the factory
 * validates `gh` availability at construction time (fail fast).
 */

import type { KoiError, Result } from "@koi/core";
import { parseGhError } from "./parse-gh-error.js";

/** Options for a single `gh` invocation. */
export interface GhExecuteOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

/** Injectable interface for executing `gh` CLI commands. */
export interface GhExecutor {
  readonly execute: (
    args: readonly string[],
    options?: GhExecuteOptions,
  ) => Promise<Result<string, KoiError>>;
}

/** Configuration for the real GhExecutor. */
export interface GhExecutorConfig {
  readonly cwd?: string;
}

/**
 * Create a real GhExecutor backed by Bun.spawn.
 *
 * Validates `gh --version` at creation time — throws if `gh` is not installed.
 * Side-effect: spawns child processes for each execute() call.
 */
export async function createGhExecutor(config: GhExecutorConfig = {}): Promise<GhExecutor> {
  // Validate gh availability at construction time
  try {
    const check = Bun.spawn(["gh", "--version"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await check.exited;
    if (exitCode !== 0) {
      throw new Error("gh exited with non-zero status");
    }
  } catch (e: unknown) {
    throw new Error(
      "GitHub CLI (gh) is not installed or not in PATH. Install it: https://cli.github.com",
      { cause: e },
    );
  }

  return {
    execute: async (
      args: readonly string[],
      options?: GhExecuteOptions,
    ): Promise<Result<string, KoiError>> => {
      const cwd = options?.cwd ?? config.cwd;

      let proc: {
        readonly exited: Promise<number>;
        readonly stdout: ReadableStream;
        readonly stderr: ReadableStream;
        readonly kill: () => void;
      };

      try {
        const spawnOpts = {
          stdout: "pipe" as const,
          stderr: "pipe" as const,
          ...(cwd !== undefined && { cwd }),
        };
        const spawned = Bun.spawn(["gh", ...args], spawnOpts);
        proc = {
          exited: spawned.exited,
          stdout: spawned.stdout as ReadableStream,
          stderr: spawned.stderr as ReadableStream,
          kill: () => spawned.kill(),
        };
      } catch (e: unknown) {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Failed to spawn gh: ${e instanceof Error ? e.message : String(e)}`,
            retryable: false,
            cause: e,
          },
        };
      }

      // Handle abort signal
      const signal = options?.signal;
      if (signal) {
        const onAbort = (): void => {
          proc.kill();
        };
        if (signal.aborted) {
          proc.kill();
          return {
            ok: false,
            error: {
              code: "TIMEOUT",
              message: "Operation aborted",
              retryable: false,
            },
          };
        }
        signal.addEventListener("abort", onAbort, { once: true });

        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        // Clean up listener to prevent leaks when the signal is reused
        signal.removeEventListener("abort", onAbort);

        if (exitCode !== 0) {
          return { ok: false, error: parseGhError(stderr, exitCode, args) };
        }

        return { ok: true, value: stdout.trim() };
      }

      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      if (exitCode !== 0) {
        return { ok: false, error: parseGhError(stderr, exitCode, args) };
      }

      return { ok: true, value: stdout.trim() };
    },
  };
}
