/**
 * @koi/checkpoint — End-of-turn capture middleware + CAS blob store for
 * session-level rollback.
 *
 * Spec: docs/L2/checkpoint.md
 *
 * This is the *capture half* of issue #1625. The restore half (rewind
 * protocol, /rewind slash command, in-flight queue) lands in a follow-up.
 */

export { blobPath, hasBlob, readBlob, writeBlobFromFile } from "./cas-store.js";
export type { CreateCheckpointMiddlewareInput } from "./checkpoint-middleware.js";
export { createCheckpointMiddleware } from "./checkpoint-middleware.js";
export { createGitStatusDriftDetector, parsePorcelain } from "./drift-detector.js";
export {
  buildFileOpRecord,
  capturePostImage,
  capturePreImage,
  extractPath,
} from "./file-tracking.js";
export type { CheckpointMiddlewareConfig, CheckpointPayload, DriftDetector } from "./types.js";
