/**
 * @koi/handoff — Structured context relay for agent-to-agent baton passing (Layer 2)
 *
 * @deprecated Use orchestrator DAG with enriched TaskResult instead.
 * The orchestrator now supports rich data flow (artifacts, decisions, warnings,
 * delegation) through DAG edges, making standalone handoff unnecessary.
 *
 * Provides tools (prepare_handoff, accept_handoff) and middleware for
 * packaging and injecting typed handoff envelopes between pipeline agents.
 *
 * Depends on @koi/core, @koi/sqlite-utils, @koi/nexus-client.
 */

// accept tool
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export type { CreateAcceptToolConfig } from "./accept-tool.js";
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export { createAcceptTool } from "./accept-tool.js";
// errors
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export {
  conflictError,
  internalError,
  notFoundError,
  validateHandoffId,
  validationError,
} from "./errors.js";
// middleware
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export { createHandoffMiddleware } from "./middleware.js";
// nexus store
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export type { NexusHandoffStoreConfig } from "./nexus-store.js";
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export { createNexusHandoffStore } from "./nexus-store.js";
// prepare tool
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export type { CreatePrepareToolConfig } from "./prepare-tool.js";
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export { createPrepareTool, resolveTarget } from "./prepare-tool.js";
// provider
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export { createHandoffProvider } from "./provider.js";
// skill
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export { HANDOFF_SKILL, HANDOFF_SKILL_CONTENT, HANDOFF_SKILL_NAME } from "./skill.js";
// sqlite store
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export type { SqliteHandoffStoreConfig } from "./sqlite-store.js";
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export { createSqliteHandoffStore } from "./sqlite-store.js";
// store
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export type { HandoffStore, HandoffStoreConfig } from "./store.js";
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export { createHandoffStore, createInMemoryHandoffStore } from "./store.js";
// summary
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export { generateHandoffSummary } from "./summary.js";
// types
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export type { HandoffConfig, HandoffMiddlewareConfig } from "./types.js";
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export { ACCEPT_HANDOFF_DESCRIPTOR, PREPARE_HANDOFF_DESCRIPTOR } from "./types.js";
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export type { PrepareInput, ValidateAcceptResult, ValidatePrepareResult } from "./validate.js";
// validation
/** @deprecated Use orchestrator DAG with enriched TaskResult instead. */
export { validateAcceptInput, validateArtifactRefs, validatePrepareInput } from "./validate.js";
