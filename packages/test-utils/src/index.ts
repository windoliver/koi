/**
 * @koi/test-utils — Shared test fixtures and contract test suites.
 *
 * Provides mock contexts, handlers, agents, engine adapters, spy utilities,
 * and reusable contract test suites for validating EngineAdapter and
 * ChannelAdapter implementations. Depends on @koi/core only.
 */

export type {
  MockAgentOptions,
  MockEngineAdapterOptions,
  MockEngineData,
  MockStatefulEngineOptions,
} from "./agents.js";
export {
  createMockAgent,
  createMockEngineAdapter,
  createMockStatefulEngine,
} from "./agents.js";
export type { CapturedOutput } from "./capture-output.js";
export { captureOutput } from "./capture-output.js";
export type { ChannelContractOptions } from "./channel-contract.js";
export { testChannelAdapter } from "./channel-contract.js";
export type { MockMemoryComponentOptions } from "./components.js";
export { createMockMemoryComponent } from "./components.js";
export { createTestConfig, createTestConfigStore } from "./config.js";
export { createMockSessionContext, createMockTurnContext } from "./contexts.js";
export type { EngineContractOptions } from "./engine-contract.js";
export { testEngineAdapter } from "./engine-contract.js";
export type { SpyModelHandler, SpyToolHandler } from "./handlers.js";
export {
  createMockModelHandler,
  createMockToolHandler,
  createSpyModelHandler,
  createSpyToolHandler,
} from "./handlers.js";
export { runSessionPersistenceContractTests } from "./session-persistence-contract.js";
export { runSnapshotChainStoreContractTests } from "./snapshot-chain-contract.js";
export { runForgeStoreContractTests } from "./store-contract.js";
export { createManifestFile, makeTempDir, withTempDir } from "./temp-dir.js";
export type { MockValidationError, MockValidationResult, MockValidator } from "./validators.js";
export {
  createAsyncValidator,
  createConditionalValidator,
  createFailingValidator,
  createMockValidator,
  createThrowingValidator,
} from "./validators.js";
