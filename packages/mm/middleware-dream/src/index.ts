/**
 * @koi/middleware-dream — Dream consolidation middleware for Koi agent memory.
 *
 * Fires background memory consolidation at session end when sufficient
 * sessions and time have elapsed since the last dream.
 */

export { createDreamMiddleware } from "./middleware.js";
export type { DreamMiddlewareConfig } from "./types.js";
