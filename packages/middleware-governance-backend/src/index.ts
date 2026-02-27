/**
 * @koi/middleware-governance-backend — Pluggable policy evaluation gate (Layer 2)
 *
 * Wraps every model call and tool call with a GovernanceBackend.evaluate()
 * call. Fail-closed: if evaluate() throws, the error propagates as a denial.
 *
 * Depends on @koi/core and @koi/errors only.
 */

export type { GovernanceBackendMiddlewareConfig } from "./config.js";
export { validateGovernanceBackendConfig } from "./config.js";
export { createGovernanceBackendMiddleware } from "./governance-backend-middleware.js";
