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
export { assertKoiError } from "./assert-koi-error.js";
export { assertErr, assertOk } from "./assert-result.js";
export {
  createTestAgentArtifact,
  createTestImplementationArtifact,
  createTestSkillArtifact,
  createTestToolArtifact,
  DEFAULT_PROVENANCE,
} from "./brick-artifacts.js";
export type { BrickRegistryContractOptions } from "./brick-registry-contract.js";
export { testBrickRegistryContract } from "./brick-registry-contract.js";
export type { CapturedOutput } from "./capture-output.js";
export { captureOutput } from "./capture-output.js";
export type { ChannelContractOptions } from "./channel-contract.js";
export { testChannelAdapter } from "./channel-contract.js";
export type { MockMemoryComponentOptions, RecallCall, StoreCall } from "./components.js";
export { createMockMemoryComponent } from "./components.js";
export { createTestConfig, createTestConfigStore } from "./config.js";
export {
  createMockInboundMessage,
  createMockSessionContext,
  createMockTurnContext,
} from "./contexts.js";
export type { EngineContractOptions } from "./engine-contract.js";
export { testEngineAdapter } from "./engine-contract.js";
export { runEventBackendContractTests } from "./event-backend-contract.js";
export type { MockEventBackend } from "./event-backend-mock.js";
export { createMockEventBackend } from "./event-backend-mock.js";
export type {
  EventSourcedRegistryForTest,
  EventSourcedRegistryTestContext,
} from "./event-sourced-registry-contract.js";
export { runEventSourcedRegistryContractTests } from "./event-sourced-registry-contract.js";
export { createFactory } from "./factory.js";
export type {
  MockGovernanceBackendOverrides,
  MockGovernanceControllerOverrides,
} from "./governance.js";
export { createMockGovernanceBackend, createMockGovernanceController } from "./governance.js";
export type { SpyModelHandler, SpyModelStreamHandler, SpyToolHandler } from "./handlers.js";
export {
  createMockModelHandler,
  createMockModelStreamHandler,
  createMockToolHandler,
  createSpyModelHandler,
  createSpyModelStreamHandler,
  createSpyToolHandler,
} from "./handlers.js";
export { runHarnessContractTests } from "./harness-contract.js";
export {
  createMockContextSummary,
  createMockHarness,
  createMockTaskPlan,
} from "./harness-mocks.js";
export { createInMemoryBrickRegistry } from "./in-memory-brick-registry.js";
export type { MiddlewareContractOptions } from "./middleware-contract/index.js";
export { testMiddlewareContract } from "./middleware-contract/index.js";
export type { FakePermissionBackend, FakePermissionBackendOptions } from "./permission-backend.js";
export { createFakePermissionBackend } from "./permission-backend.js";
export type { ResolverContractOptions } from "./resolver-contract.js";
export { testResolverContract } from "./resolver-contract.js";
export { runSessionPersistenceContractTests } from "./session-persistence-contract.js";
export type { SkillRegistryContractOptions } from "./skill-registry-contract.js";
export { testSkillRegistryContract } from "./skill-registry-contract.js";
export { createInMemorySkillRegistry } from "./skill-registry-memory.js";
export { runSnapshotChainStoreContractTests } from "./snapshot-chain-contract.js";
export { runForgeStoreContractTests } from "./store-contract.js";
export { createManifestFile, makeTempDir, withTempDir } from "./temp-dir.js";
export type { TempGitRepo } from "./temp-git-repo.js";
export { createTempGitRepo } from "./temp-git-repo.js";
export type { MockValidationError, MockValidationResult, MockValidator } from "./validators.js";
export {
  createAsyncValidator,
  createConditionalValidator,
  createFailingValidator,
  createMockValidator,
  createThrowingValidator,
} from "./validators.js";
export type { VersionIndexContractOptions } from "./version-index-contract.js";
export { testVersionIndexContract } from "./version-index-contract.js";
export { createInMemoryVersionIndex } from "./version-index-memory.js";
