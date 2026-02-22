/**
 * @koi/test-utils — Shared test fixtures for middleware testing.
 *
 * Provides mock contexts, handlers, and spy utilities.
 * Depends on @koi/core only.
 */

export { createMockSessionContext, createMockTurnContext } from "./contexts.js";
export type { SpyModelHandler, SpyToolHandler } from "./handlers.js";
export {
  createMockModelHandler,
  createMockToolHandler,
  createSpyModelHandler,
  createSpyToolHandler,
} from "./handlers.js";
