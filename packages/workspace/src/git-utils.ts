/**
 * Git command execution utilities.
 *
 * Thin wrapper around Bun.spawn for running git commands and
 * mapping stderr to KoiError values.
 */

import type { KoiError, Result } from "@koi/core";

/**
 * Run a git command and return the stdout as a Result.
 *
 * On non-zero exit, returns a Result.error with the stderr parsed
 * into a KoiError. Side-effect: spawns a child process.
 */
export async function runGit(
  args: readonly string[],
  cwd: string,
): Promise<Result<string, KoiError>> {
  let proc: {
    readonly exited: Promise<number>;
    readonly stdout: ReadableStream;
    readonly stderr: ReadableStream;
  };
  try {
    const spawned = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    proc = {
      exited: spawned.exited,
      stdout: spawned.stdout as ReadableStream,
      stderr: spawned.stderr as ReadableStream,
    };
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Failed to spawn git: ${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
        cause: e,
      },
    };
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    return { ok: false, error: parseGitError(stderr, args) };
  }

  return { ok: true, value: stdout.trim() };
}

/** Map git stderr messages to structured KoiError values. */
export function parseGitError(stderr: string, args: readonly string[]): KoiError {
  const trimmed = stderr.trim();

  if (trimmed.includes("already exists")) {
    return {
      code: "CONFLICT",
      message: trimmed,
      retryable: false,
      context: { command: `git ${args.join(" ")}` },
    };
  }

  if (trimmed.includes("not a git repository")) {
    return {
      code: "VALIDATION",
      message: trimmed,
      retryable: false,
      context: { command: `git ${args.join(" ")}` },
    };
  }

  if (trimmed.includes("not found") || trimmed.includes("does not exist")) {
    return {
      code: "NOT_FOUND",
      message: trimmed,
      retryable: false,
      context: { command: `git ${args.join(" ")}` },
    };
  }

  return {
    code: "EXTERNAL",
    message: `git ${args[0]} failed: ${trimmed}`,
    retryable: false,
    context: { command: `git ${args.join(" ")}` },
  };
}

/** Resolve the base path for worktrees relative to the repo. */
export function resolveWorktreeBasePath(repoPath: string, explicit?: string): string {
  if (explicit) return explicit;
  const repoName = repoPath.split("/").pop() || "repo";
  return `${repoPath}/../${repoName}-workspaces`;
}
