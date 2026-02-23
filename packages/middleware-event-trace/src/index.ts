/**
 * @koi/middleware-event-trace — Per-event trace middleware (L2).
 *
 * Traces every LLM/tool call individually, enabling per-event
 * granularity for mid-turn rewind.
 */

export { createEventTraceMiddleware } from "./event-trace.js";
export type { TraceCollector } from "./trace-collector.js";
export { createTraceCollector } from "./trace-collector.js";
export type { EventTraceConfig, EventTraceHandle } from "./types.js";
