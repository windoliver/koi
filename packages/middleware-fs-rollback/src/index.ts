/**
 * @koi/middleware-fs-rollback — Filesystem side-effect capture and rollback (L2).
 *
 * Captures file changes during tool calls and enables rollback to any
 * previous snapshot node in the chain.
 */

export { capturePreState } from "./capture.js";
export { computeCompensatingOps } from "./compensate.js";
export { createFsRollbackMiddleware } from "./fs-rollback.js";
export { rollbackTo } from "./rollback.js";
export type { FsRollbackConfig, FsRollbackHandle } from "./types.js";
