/**
 * @koi/dashboard-api — HTTP handler for the Koi web dashboard.
 *
 * L2 package: imports from @koi/core, @koi/dashboard-types.
 *
 * Provides:
 * - createDashboardHandler() factory — mountable HTTP handler
 * - REST endpoints for agents, channels, skills, metrics
 * - Filesystem endpoints for Nexus namespace browsing
 * - Runtime view endpoints for computed state
 * - Command endpoints for imperative operations
 * - SSE streaming with 100ms batched events
 * - Static asset serving with content-hashed cache headers
 */

export type { DashboardHandlerOptions, DashboardHandlerResult } from "./handler.js";
export { createDashboardHandler } from "./handler.js";
export type { Route, RouteHandler, RouteMatch, RouteParams, Router } from "./router.js";
export { createRouter, errorResponse, jsonResponse } from "./router.js";
export { encodeSseKeepalive, encodeSseMessage, encodeSseMessageWithId } from "./sse/encoder.js";
export type { SseProducer } from "./sse/producer.js";
export { createSseProducer } from "./sse/producer.js";
export type { StaticServeResult } from "./static-serve.js";
export { createStaticServe } from "./static-serve.js";
