/**
 * @koi/middleware-memory — Persistent memory injection (Layer 2)
 *
 * Injects recalled memories into model calls and stores
 * conversation turns for future recall.
 * Depends on @koi/core only.
 */

export type { MemoryMiddlewareConfig } from "./config.js";
export { validateConfig } from "./config.js";
export { createMemoryMiddleware } from "./memory.js";
export type { MemoryEntry, MemoryStore } from "./store.js";
export { createInMemoryStore } from "./store.js";
