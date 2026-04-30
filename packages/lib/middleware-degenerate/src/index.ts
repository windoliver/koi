/**
 * @koi/middleware-degenerate — Variant selection middleware for degenerate tools.
 *
 * L2 package. Intercepts tool calls for capabilities with multiple implementations,
 * selects the primary via configurable strategy, and handles failover on failure.
 */

export { validateDegenerateConfig } from "./config.js";
export { createDegenerateMiddleware } from "./degenerate-middleware.js";
export type { DegenerateHandle, DegenerateMiddlewareConfig } from "./types.js";
