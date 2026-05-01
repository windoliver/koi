/**
 * @koi/middleware-fs-rollback — Snapshot/restore working tree around
 * protected tool calls via `git stash` (L2).
 *
 * Snapshots the working tree before a `fs_write` / `fs_edit` (or any
 * configured protected tool), restores it on tool failure. Closes the
 * third sub-task of issue #1421.
 *
 * Depends on @koi/core and @koi/git-utils only.
 */

export { createFsRollbackMiddleware } from "./fs-rollback-middleware.js";
export type { FsRollbackConfig, FsRollbackHandle, RunGitFn, RunGitOutcome } from "./types.js";
