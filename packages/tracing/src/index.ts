/**
 * @koi/tracing — OpenTelemetry distributed tracing middleware (L2).
 *
 * Emits OTel spans for session lifecycle, turns, model calls, and tool calls.
 * Zero-cost when no TracerProvider is registered.
 * Depends on @koi/core and @opentelemetry/api.
 */

export type { TracingConfig } from "./config.js";
export { validateTracingConfig } from "./config.js";
export { createTracedFetch } from "./traced-fetch.js";
export { createTracingMiddleware } from "./tracing.js";
