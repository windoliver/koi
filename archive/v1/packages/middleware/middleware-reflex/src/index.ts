/**
 * @koi/middleware-reflex — Rule-based short-circuit for known message patterns.
 *
 * Intercepts inbound messages matching predefined rules and returns
 * canned responses without hitting the LLM, saving tokens and latency.
 */

export type { ReflexMiddlewareConfig } from "./config.js";
export { DEFAULT_COOLDOWN_MS, DEFAULT_PRIORITY, validateReflexConfig } from "./config.js";
export { descriptor } from "./descriptor.js";
export { createReflexMiddleware } from "./reflex.js";
export { textOf } from "./text-of.js";
export type { ReflexMetrics, ReflexRule } from "./types.js";
