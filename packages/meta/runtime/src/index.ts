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

// Types
export type {
  MiddlewareDebugEntry,
  RuntimeConfig,
  RuntimeDebugInfo,
  RuntimeHandle,
  ToolDebugEntry,
} from "./types.js";
export { DEFAULT_STREAM_TIMEOUT_MS, VCR_STREAM_TIMEOUT_MS } from "./types.js";
