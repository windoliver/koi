/**
 * @koi/handoff — Structured context relay for agent-to-agent baton passing (Layer 2)
 *
 * Provides tools (prepare_handoff, accept_handoff) and middleware for
 * packaging and injecting typed handoff envelopes between pipeline agents.
 *
 * Depends on @koi/core, @koi/sqlite-utils, @koi/nexus-client.
 */

// accept tool
export type { CreateAcceptToolConfig } from "./accept-tool.js";
export { createAcceptTool } from "./accept-tool.js";
// errors
export {
  conflictError,
  internalError,
  notFoundError,
  validateHandoffId,
  validationError,
} from "./errors.js";
// middleware
export { createHandoffMiddleware } from "./middleware.js";
// nexus store
export type { NexusHandoffStoreConfig } from "./nexus-store.js";
export { createNexusHandoffStore } from "./nexus-store.js";
// prepare tool
export type { CreatePrepareToolConfig } from "./prepare-tool.js";
export { createPrepareTool } from "./prepare-tool.js";
// provider
export { createHandoffProvider } from "./provider.js";
// skill
export { HANDOFF_SKILL, HANDOFF_SKILL_CONTENT, HANDOFF_SKILL_NAME } from "./skill.js";
// sqlite store
export type { SqliteHandoffStoreConfig } from "./sqlite-store.js";
export { createSqliteHandoffStore } from "./sqlite-store.js";
// store
export type { HandoffStore, HandoffStoreConfig } from "./store.js";
export { createHandoffStore, createInMemoryHandoffStore } from "./store.js";
// summary
export { generateHandoffSummary } from "./summary.js";
// types
export type { HandoffConfig, HandoffMiddlewareConfig } from "./types.js";
export { ACCEPT_HANDOFF_DESCRIPTOR, PREPARE_HANDOFF_DESCRIPTOR } from "./types.js";
export type { PrepareInput, ValidateAcceptResult, ValidatePrepareResult } from "./validate.js";
// validation
export { validateAcceptInput, validateArtifactRefs, validatePrepareInput } from "./validate.js";
