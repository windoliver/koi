/**
 * @koi/handoff — Structured context relay for agent-to-agent baton passing (Layer 2)
 *
 * Provides tools (prepare_handoff, accept_handoff) and middleware for
 * packaging and injecting typed handoff envelopes between pipeline agents.
 *
 * Depends on @koi/core only.
 */

// accept tool
export type { CreateAcceptToolConfig } from "./accept-tool.js";
export { createAcceptTool } from "./accept-tool.js";
// middleware
export { createHandoffMiddleware } from "./middleware.js";
// prepare tool
export type { CreatePrepareToolConfig } from "./prepare-tool.js";
export { createPrepareTool } from "./prepare-tool.js";
// provider
export { createHandoffProvider } from "./provider.js";
// store
export type { HandoffStore } from "./store.js";
export { createHandoffStore } from "./store.js";
// summary
export { generateHandoffSummary } from "./summary.js";
// types
export type { HandoffConfig, HandoffMiddlewareConfig } from "./types.js";
export { ACCEPT_HANDOFF_DESCRIPTOR, PREPARE_HANDOFF_DESCRIPTOR } from "./types.js";
export type { PrepareInput, ValidateAcceptResult, ValidatePrepareResult } from "./validate.js";
// validation
export { validateAcceptInput, validateArtifactRefs, validatePrepareInput } from "./validate.js";
