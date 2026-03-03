/**
 * @koi/middleware-sandbox — Sandbox policy enforcement middleware (Layer 2)
 *
 * Defense-in-depth timeout, output truncation, error classification,
 * and observability for sandboxed tool execution.
 * Depends on @koi/core and @koi/errors only.
 */

export type { SandboxMiddlewareConfig } from "./config.js";
export {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  DEFAULT_SKIP_TIERS,
  DEFAULT_TIMEOUT_GRACE_MS,
  validateConfig,
} from "./config.js";
export { descriptor } from "./descriptor.js";
export { createSandboxMiddleware } from "./sandbox-middleware.js";
