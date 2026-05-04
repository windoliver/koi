/**
 * @koi/handoff — Structured context relay between agents.
 *
 * Spec: docs/L2/handoff.md
 *
 * Typed envelope (HandoffEnvelope) carries phase, results, artifacts,
 * decisions, and warnings between agents. A pair of tools — prepare_handoff
 * (sender) and accept_handoff (receiver) — manage the lifecycle, while
 * HandoffMiddleware auto-injects a summary into the receiving agent's
 * first model call.
 */

export { type CreateAcceptToolConfig, createAcceptTool } from "./accept-tool.js";
export {
  conflictError,
  expiredError,
  externalError,
  internalError,
  notFoundError,
  validateHandoffId,
  validationError,
} from "./errors.js";
export { createHandoffMiddleware } from "./middleware.js";
export {
  createNexusHandoffStore,
  type NexusHandoffStoreConfig,
} from "./nexus-store.js";
export {
  type CreatePrepareToolConfig,
  createPrepareTool,
  type ResolveTargetResult,
  resolveTarget,
} from "./prepare-tool.js";
export { createHandoffProvider } from "./provider.js";
export {
  createSqliteHandoffStore,
  type SqliteHandoffStoreConfig,
} from "./sqlite-store.js";
export {
  createHandoffStore,
  createInMemoryHandoffStore,
  DEFAULT_HANDOFF_TTL_MS,
  type HandoffStore,
  type HandoffStoreConfig,
} from "./store.js";
export { generateHandoffSummary } from "./summary.js";
export {
  ACCEPT_HANDOFF_DESCRIPTOR,
  type HandoffConfig,
  type HandoffMiddlewareConfig,
  PREPARE_HANDOFF_DESCRIPTOR,
} from "./types.js";
export {
  type PrepareInput,
  type ValidateAcceptResult,
  type ValidatePrepareResult,
  validateAcceptInput,
  validateArtifactRefs,
  validatePrepareInput,
} from "./validate.js";
