// Core factory

// Debug session API — re-exported from @koi/debug for runtime consumers
export type {
  DebugAttachConfig,
  DebugAttachResult,
  EventRingBuffer,
  SupportedBreakpointEventKind,
} from "@koi/debug";
export {
  createDebugAttach,
  createEventRingBuffer,
  DEBUG_MIDDLEWARE_NAME,
  DEBUG_MIDDLEWARE_PRIORITY,
  DEFAULT_EVENT_BUFFER_SIZE,
  hasDebugSession,
  matchesBreakpoint,
  SUPPORTED_EVENT_KINDS,
} from "@koi/debug";
export type {
  IterationRecord as LoopIterationRecord,
  LoopEvent,
  LoopRuntime,
  LoopStatus,
  RunUntilPassConfig,
  RunUntilPassResult,
  Verifier,
  VerifierContext,
  VerifierFailureReason,
  VerifierResult,
} from "@koi/loop";
// Convergence loop (L2 @koi/loop)
export {
  createArgvGate,
  createCompositeGate,
  createFileGate,
  runUntilPass,
} from "@koi/loop";
export type { Cassette, CassetteRegistry, CassetteSchemaVersion, ReplayContext } from "@koi/replay";
// Cassette (VCR replay) — re-exported from @koi/replay
export {
  CASSETTE_SCHEMA_VERSION,
  clearCassetteCache,
  createCassetteRecorder,
  createRegistry,
  createReplayAdapter,
  createReplayContext,
  loadCassette,
} from "@koi/replay";
// Activity-based stream timeouts (#1638)
export type {
  ActivityTerminationReason,
  ActivityTimeoutConfig,
  IdleWarningInfo,
} from "./apply-activity-timeout.js";
export {
  ACTIVITY_IDLE_WARNING,
  ACTIVITY_TERMINATED_IDLE,
  ACTIVITY_TERMINATED_WALL_CLOCK,
  applyActivityTimeout,
} from "./apply-activity-timeout.js";
// Artifact tool provider (@koi/artifacts wiring)
export type { ArtifactToolProviderConfig } from "./artifact-tool-provider.js";
export { createArtifactToolProvider } from "./artifact-tool-provider.js";
// Browser backend factory (@koi/browser-playwright + @koi/browser-ext wiring)
export type { BrowserBackendConfig } from "./create-browser-backend.js";
export { createBrowserBackend } from "./create-browser-backend.js";
export type { FileSystemTools } from "./create-filesystem-provider.js";
// Filesystem dispatch + provider
export {
  createFileSystemProvider,
  createFileSystemTools,
  createToolDispatcher,
} from "./create-filesystem-provider.js";
// Interaction tools provider (TodoWrite, EnterPlanMode, ExitPlanMode, AskUserQuestion)
export type { InteractionProviderConfig } from "./create-interaction-provider.js";
export { createInteractionProvider } from "./create-interaction-provider.js";
export { createRuntime } from "./create-runtime.js";
// Credentials producer (env-var-backed CredentialComponent)
export type { EnvCredentialsOptions } from "./credentials.js";
export { createCredentialsProvider, createEnvCredentials } from "./credentials.js";
// Debug
export { collectDebugInfo, formatDebugInfo } from "./debug/collect-debug-info.js";
export type { HookObserverConfig } from "./middleware/hook-dispatch.js";
// Middleware (hook observer, MCP lifecycle)
export { createHookObserver } from "./middleware/hook-dispatch.js";
export type { McpLifecycleConfig } from "./middleware/mcp-lifecycle.js";
export { recordMcpLifecycle } from "./middleware/mcp-lifecycle.js";
export type { TraceWrapperConfig } from "./middleware/trace-wrapper.js";
export { wrapMiddlewareWithTrace } from "./middleware/trace-wrapper.js";
export {
  resolveFileSystem,
  resolveFileSystemAsync,
  validateFileSystemConfig,
} from "./resolve-filesystem.js";
// Skills-MCP bridge
export type {
  MapToolDescriptorsResult,
  SkillsMcpBridge,
  SkillsMcpBridgeConfig,
} from "./skills-mcp-bridge.js";
export {
  createSkillsMcpBridge,
  mapToolDescriptorsToSkillMetadata,
  mapToolDescriptorToSkillMetadata,
} from "./skills-mcp-bridge.js";

// Stubs (for direct use in tests)
export { createStubAdapter } from "./stubs/stub-adapter.js";
export { createStubChannel } from "./stubs/stub-channel.js";
export { createStubMiddleware, PHASE1_MIDDLEWARE_NAMES } from "./stubs/stub-middleware.js";
export type { AtifExportOptions } from "./trajectory/atif-mapper.js";
export { mapAtifToRichTrajectory, mapRichTrajectoryToAtif } from "./trajectory/atif-mapper.js";
export type { AtifDocumentDelegate, AtifDocumentStoreConfig } from "./trajectory/atif-store.js";
// Trajectory (ATIF store)
export { createAtifDocumentStore } from "./trajectory/atif-store.js";
export type { AtifDocument } from "./trajectory/atif-types.js";
export { createFsAtifDelegate } from "./trajectory/fs-delegate.js";
export type { NexusTrajectoryConfig } from "./trajectory/nexus-delegate.js";
export { createNexusAtifDelegate } from "./trajectory/nexus-delegate.js";
// Outcome linkage (#1465)
export { createInMemoryOutcomeStore } from "./trajectory/outcome-memory-store.js";
export type { NexusOutcomeConfig } from "./trajectory/outcome-nexus-delegate.js";
export { createNexusOutcomeDelegate } from "./trajectory/outcome-nexus-delegate.js";

// Types
export type {
  MiddlewareDebugEntry,
  RuntimeConfig,
  RuntimeDebugInfo,
  RuntimeHandle,
  ToolDebugEntry,
} from "./types.js";
export { DEFAULT_ACTIVITY_MAX_DURATION_MS, DEFAULT_STREAM_TIMEOUT_MS } from "./types.js";
