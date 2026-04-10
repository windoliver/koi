/**
 * @koi/test — test doubles, context factories, event collectors, and
 * assertion helpers for Koi agent tests.
 *
 * Importable from both L1 (@koi/engine) and L2 feature packages.
 * Depends only on @koi/core.
 */

// Result assertions
export { assertErr, assertErrCode, assertOk } from "./assert-result.js";
// Transcript assertions
export {
  assertCostUnder,
  assertNoToolErrors,
  assertTextContains,
  assertTextMatches,
  assertToolSequence,
  assertTurnCount,
} from "./assertions.js";
// Event collectors
export {
  collectEvents,
  collectOutput,
  collectText,
  collectToolNames,
  collectUsage,
  filterByKind,
} from "./collect.js";
export type { FakeEngineConfig, FakeEngineResult, TurnBodyEvent } from "./create-fake-engine.js";
// Fake engine adapter
export { createFakeEngine } from "./create-fake-engine.js";
export type {
  ExhaustionPolicy,
  MockAdapterConfig,
  MockAdapterResult,
  MockCall,
  RecordedModelCall,
} from "./create-mock-adapter.js";
// Mock model adapter
export { createMockAdapter, streamTextChunks, textResponse } from "./create-mock-adapter.js";
export type { MockChannelConfig, MockChannelResult } from "./create-mock-channel.js";
// Mock channel
export { createMockChannel } from "./create-mock-channel.js";
// Context factories
export { createMockSessionContext, createMockTurnContext } from "./create-mock-context.js";
export type {
  SpyModelHandler,
  SpyModelStreamHandler,
  SpyToolHandler,
} from "./create-mock-handlers.js";
// Handler spies
export {
  createSpyModelHandler,
  createSpyModelStreamHandler,
  createSpyToolHandler,
} from "./create-mock-handlers.js";
// Message factory
export { createMockInboundMessage } from "./create-mock-message.js";
export type { MockToolConfig, MockToolResult, RecordedToolCall } from "./create-mock-tool.js";
// Mock tool
export { createMockTool } from "./create-mock-tool.js";
