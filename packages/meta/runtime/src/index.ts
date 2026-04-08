// Core factory

// Cassette (VCR replay)
export { loadCassette } from "./cassette/load-cassette.js";
export { createReplayAdapter } from "./cassette/replay-adapter.js";
export type { Cassette } from "./cassette/types.js";
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
export type { SkillsMcpBridge, SkillsMcpBridgeConfig } from "./skills-mcp-bridge.js";
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
export { DEFAULT_STREAM_TIMEOUT_MS, VCR_STREAM_TIMEOUT_MS } from "./types.js";
