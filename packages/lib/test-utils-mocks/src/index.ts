/**
 * @koi/test-utils-mocks — Mock factories and spy helpers for Koi testing.
 *
 * Provides mock contexts, handlers, agents, engine adapters, spy utilities,
 * assertion helpers, and in-memory backend implementations.
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
  createTestCompositeArtifact,
  createTestImplementationArtifact,
  createTestSkillArtifact,
  createTestToolArtifact,
  DEFAULT_PROVENANCE,
} from "./brick-artifacts.js";
export type { CapturedOutput } from "./capture-output.js";
export { captureOutput } from "./capture-output.js";
export type { MockMemoryComponentOptions, RecallCall, StoreCall } from "./components.js";
export { createMockMemoryComponent } from "./components.js";
export { createTestConfig, createTestConfigStore } from "./config.js";
export {
  createMockInboundMessage,
  createMockSessionContext,
  createMockTurnContext,
} from "./contexts.js";
export type { MockEventBackend } from "./event-backend-mock.js";
export { createMockEventBackend } from "./event-backend-mock.js";
export { createFactory } from "./factory.js";
export type { FakeEngineAdapterConfig, FakeEngineAdapterResult } from "./fake-engine-adapter.js";
export { createFakeEngineAdapter } from "./fake-engine-adapter.js";
export { createFakeNexusFetch } from "./fake-nexus-fetch.js";
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
export {
  createMockContextSummary,
  createMockHarness,
  createMockTaskPlan,
} from "./harness-mocks.js";
export { createInMemoryBrickRegistry } from "./in-memory-brick-registry.js";
export type { FakePermissionBackend, FakePermissionBackendOptions } from "./permission-backend.js";
export { createFakePermissionBackend } from "./permission-backend.js";
export { createInMemorySkillRegistry } from "./skill-registry-memory.js";
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
export { createInMemoryVersionIndex } from "./version-index-memory.js";
