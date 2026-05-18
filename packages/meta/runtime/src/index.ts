// Core factory

// Dashboard SDK + shared contracts — re-exported so consumers depend on @koi/runtime alone
export type { DashboardClient, DashboardClientConfig } from "@koi/dashboard-client";
export { createDashboardClient } from "@koi/dashboard-client";
export type {
  AgentStatus,
  AgentStatusEvent,
  ApiResult as DashboardApiResult,
  MetricEvent,
  MetricPoint,
  MetricQuery,
  SessionEvent,
  SessionSummary,
  TraceEvent,
  TraceSpan,
  TraceView,
  WsClientFrame,
  WsEvent,
  WsSubscribe,
  WsTopic,
  WsUnsubscribe,
} from "@koi/dashboard-types";
export {
  isAgentStatusEvent,
  isMetricEvent,
  isSessionEvent,
  isTraceEvent,
  isWsEvent,
} from "@koi/dashboard-types";
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
// Cross-zone federation (L2 @koi/federation) — re-exported so runtime
// consumers compose federation middleware/sync without depending on
// @koi/federation directly.
export type {
  FederationAbortError,
  FederationConfig,
  FederationMiddlewareConfig,
  FederationPrincipalPolicy,
  FederationRemoteCapabilities,
  FederationSyncEvent,
  NexusSyncClientConfig,
  RemoteHealth,
  ServerReadsMode,
  SyncClient,
  SyncCursor,
  SyncEngineConfig,
  SyncEngineHandle,
  TenantResolverContext,
  ZoneRegistryNexusConfig,
} from "@koi/federation";
export {
  advanceCursor,
  createFederationMiddleware,
  createNexusSyncClient,
  createSyncEngine,
  createZoneRegistryNexus,
  DEFAULT_FEDERATION_CONFIG,
  deduplicateEvents,
  FEDERATION_PROTOCOL_VERSION,
  validateFederationConfig,
} from "@koi/federation";
export type {
  ChannelRegistration,
  Gateway,
  GatewayFrame,
  GatewayServer,
  Session,
} from "@koi/gateway-http";
export { createGatewayServer } from "@koi/gateway-http";
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
// Cloudflare edge function adapter (issue #1377) — stable helper/contract
// surface only. The experimental factory (`EXPERIMENTAL_createCloudflareAdapter`)
// is NOT re-exported here because its `create()` path is design-only and the
// renamed factory deliberately requires opting in at the package import site.
// The helpers below (config validator, JCS canonicaliser, fingerprint,
// shim-response mapper) and the config type are stable building blocks
// callers need today, so they ship under the stable runtime root.
// `@koi/sandbox-vercel` is fully design-only and is not exported.
export type { CloudflareAdapterConfig } from "@koi/sandbox-cloudflare";
export {
  computeDedupeFingerprint,
  jcsCanonicalise,
  mapShimResponse,
  validateCloudflareAdapterConfig,
} from "@koi/sandbox-cloudflare";
// Sandbox router (multi-backend executor — issue #1641)
export type {
  BuildDecisionInput,
  MatchRejection,
  MatchResult,
  RouterConfig,
  SandboxRouter,
  SelectionAttempt,
  SelectionDecision,
} from "@koi/sandbox-router";
export { buildDecision, createSandboxRouter, matchAdapters } from "@koi/sandbox-router";
export type {
  SshAdapterConfig,
  SshClient,
  SshClientFactory,
  SshExecResult,
  SshTarget,
} from "@koi/sandbox-ssh";
export { createSshAdapter, defaultSshClientFactory } from "@koi/sandbox-ssh";
// In-process WASM executor types only (issue #1377). The `createWasmExecutor`
// factory is intentionally NOT re-exported here: the in-process implementation
// runs the guest synchronously and cannot preempt a runaway export, so it is
// not a safe default for untrusted WASM. Trusted callers import the factory
// directly from `@koi/sandbox-wasm`. A future Worker-thread-backed executor
// will be the default once preemption is available.
export type {
  WasmCall,
  WasmError,
  WasmErrorCode,
  WasmExecuteOptions,
  WasmExecutor,
  WasmResult,
} from "@koi/sandbox-wasm";
// Speculative fork execution API — hosts inject fork, overlay, and UI adapters.
export type {
  PresentSpeculationResult,
  SpeculationAcceptResponse,
  SpeculationAcceptResult,
  SpeculationController,
  SpeculationControllerConfig,
  SpeculationFallbackReason,
  SpeculationForkAgent,
  SpeculationForkRequest,
  SpeculationForkResult,
  SpeculationOverlay,
  SpeculationOverlayManager,
  SpeculationPresentedResult,
  SpeculationRejectResponse,
  SpeculationSnapshot,
  SpeculationStartResult,
  SpeculationStatus,
  StartSpeculationRequest,
} from "@koi/speculation";
export { createSpeculationController } from "@koi/speculation";
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
// authed_fetch tool (gov-15) — agent-facing tool that consumes CREDENTIALS
export type { AuthedFetchToolOptions } from "./authed-fetch-tool.js";
export { createAuthedFetchTool } from "./authed-fetch-tool.js";
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
export type {
  MountDescriptionsSnapshot,
  MountDescriptionsState,
} from "./mount-descriptions-middleware.js";
export {
  createMountDescriptionsMiddleware,
  createMountDescriptionsState,
} from "./mount-descriptions-middleware.js";
export {
  resolveFileSystem,
  resolveFileSystemAsync,
  validateFileSystemConfig,
} from "./resolve-filesystem.js";
export type { RouterAdapterShimOptions } from "./router-adapter-shim.js";
export { createRouterAdapterShim } from "./router-adapter-shim.js";
export type { CreateDefaultSandboxRouterOptions } from "./sandbox-router-default.js";
export { createDefaultSandboxRouter } from "./sandbox-router-default.js";
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
export type {
  AtifDocumentAppendBatch,
  AtifDocumentAppendState,
  AtifDocumentDelegate,
  AtifDocumentHeader,
  AtifDocumentStoreConfig,
} from "./trajectory/atif-store.js";
// Trajectory (ATIF store)
export {
  createAtifAppendStateFromDocument,
  createAtifDocumentStore,
} from "./trajectory/atif-store.js";
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
  RuntimeAutoHarnessConfig,
  RuntimeAutoHarnessHandle,
  RuntimeConfig,
  RuntimeDebugInfo,
  RuntimeHandle,
  ToolDebugEntry,
} from "./types.js";
export { DEFAULT_ACTIVITY_MAX_DURATION_MS, DEFAULT_STREAM_TIMEOUT_MS } from "./types.js";
