/**
 * @koi/middleware-fs-rollback — Snapshot/restore the target file around
 * protected tool calls (L2).
 *
 * Snapshots the bytes at the target `path` before a `fs_write` / `fs_edit`
 * (or any configured protected tool) call. On tool failure, restores those
 * exact bytes (or unlinks the file if it didn't exist). Touches only the
 * target path — no git, no working-tree resets, no impact on unrelated files.
 *
 * Depends on @koi/core only.
 */

export { createFsRollbackMiddleware } from "./fs-rollback-middleware.js";
export type { FsReadResult, FsRollbackConfig, FsRollbackHandle, FsSeam } from "./types.js";
