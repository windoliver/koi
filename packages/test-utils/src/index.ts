/**
 * @koi/test-utils — Shared test fixtures for the Koi agent engine.
 *
 * Provides mock contexts, handlers, agents, engine adapters, and spy utilities.
 * Depends on @koi/core only.
 */

export type { MockAgentOptions, MockEngineAdapterOptions } from "./agents.js";
export { createMockAgent, createMockEngineAdapter } from "./agents.js";
export { createMockSessionContext, createMockTurnContext } from "./contexts.js";
export type { SpyModelHandler, SpyToolHandler } from "./handlers.js";
export {
  createMockModelHandler,
  createMockToolHandler,
  createSpyModelHandler,
  createSpyToolHandler,
} from "./handlers.js";
