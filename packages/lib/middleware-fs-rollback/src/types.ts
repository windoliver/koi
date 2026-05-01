/**
 * Configuration and handle types for the filesystem rollback middleware.
 */

import type { KoiMiddleware } from "@koi/core";

/**
 * Result shape returned by the optional `runGit` seam injected into
 * {@link FsRollbackConfig}. Mirrors what a thin wrapper over `Bun.spawn`
 * would produce: an exit-code indicator plus captured stdout/stderr.
 *
 * Tests inject a mock that captures call history and returns canned
 * output; the production default delegates to `@koi/git-utils`.
 */
export interface RunGitOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunGitFn = (args: readonly string[], cwd: string) => Promise<RunGitOutcome>;

/** Configuration for {@link createFsRollbackMiddleware}. */
export interface FsRollbackConfig {
  /**
   * Tool ids that should be wrapped with snapshot/restore. Default:
   * `["fs_write", "fs_edit"]`. Match v1 prefix convention.
   */
  readonly protectedTools?: readonly string[] | undefined;
  /**
   * Working directory for git commands. Default: `process.cwd()`.
   * The middleware resolves the git root once via `git rev-parse
   * --show-toplevel` from this directory.
   */
  readonly cwd?: string | undefined;
  /**
   * Optional seam — replaces the real Bun.spawn-based git runner. Tests
   * pass a mock here so they don't need a real git repository.
   */
  readonly runGit?: RunGitFn | undefined;
}

/** Internal per-call tracking of a stash entry we created. */
export interface FsRollbackHandle {
  readonly middleware: KoiMiddleware;
}
