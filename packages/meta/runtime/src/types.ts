import type {
  AgentResolver,
  ApprovalHandler,
  ChannelAdapter,
  ChannelCapabilities,
  ComponentProvider,
  EngineAdapter,
  FileSystemBackend,
  FileSystemConfig,
  KoiMiddleware,
  ReportStore,
  SpawnLedger,
  ToolDescriptor,
  TrajectoryDocumentStore,
} from "@koi/core";
import type { SpawnPolicy } from "@koi/engine-compose";

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

/** Configuration for creating a runtime via the convenience config API. */
export interface RuntimeConfig {
  /** Engine adapter instance or "stub" for a passthrough stub. Default: "stub". */
  readonly adapter?: EngineAdapter | "stub" | undefined;

  /** Channel adapter instance or "stub" for a no-op CLI stub. Default: "stub". */
  readonly channel?: ChannelAdapter | "stub" | undefined;

  /** Middleware instances to include in the chain. Default: empty (all stubs). */
  readonly middleware?: readonly KoiMiddleware[] | undefined;

  /** Enable debug introspection (timing, inventory). Default: false. */
  readonly debug?: boolean | undefined;

  /**
   * Stream timeout in milliseconds. Applied via AbortSignal.timeout() to model
   * stream consumption. Default: 120_000 (2 minutes).
   */
  readonly streamTimeoutMs?: number | undefined;

  /**
   * Directory for trajectory ATIF files. When provided, creates a
   * filesystem-backed TrajectoryDocumentStore. When omitted, no store is created.
   */
  readonly trajectoryDir?: string | undefined;

  /** Agent name for ATIF document metadata. Default: "koi-runtime". */
  readonly agentName?: string | undefined;

  /** Agent version for ATIF document metadata. */
  readonly agentVersion?: string | undefined;

  /**
   * Approval handler for permission-gated tool execution.
   * When provided, threaded into TurnContext.requestApproval so permission
   * middleware can prompt the user before executing dangerous tools.
   * When omitted and a non-stub "permissions" middleware is installed,
   * createRuntime throws — fail closed rather than silently allowing.
   */
  readonly requestApproval?: ApprovalHandler | undefined;

  /** User identity for tenant-aware middleware. */
  readonly userId?: string | undefined;

  /** Channel identifier for channel-aware middleware. */
  readonly channelId?: string | undefined;

  /**
   * Tool descriptors advertised to cooperating adapters via callHandlers.tools.
   * Adapters use these to populate ModelRequest.tools so the model knows which
   * tools are available. When omitted, callHandlers.tools is empty.
   */
  readonly toolDescriptors?: readonly ToolDescriptor[] | undefined;

  /**
   * Agent resolver for definition lookup. When provided, `createRuntime` returns a
   * `spawnProvider` in `RuntimeHandle` that callers can pass to `createKoi({ providers })`
   * to register the `Spawn` tool and enable agent-to-agent delegation.
   */
  readonly resolver?: AgentResolver | undefined;

  /**
   * ReportStore for `on_demand` delivery. Required when spawned agents use
   * `delivery.kind === "on_demand"`. Passed through to the spawn provider.
   */
  readonly reportStore?: ReportStore | undefined;

  /**
   * Shared spawn ledger for process accounting. When provided it is threaded
   * into the spawn provider so cross-runtime/cross-node accounting is preserved.
   * When omitted a default in-memory ledger (capacity 50) is created locally.
   */
  readonly spawnLedger?: SpawnLedger | undefined;

  /**
   * Spawn governance policy (max depth, fan-out, total processes).
   * When omitted the DEFAULT_SPAWN_POLICY is used.
   */
  readonly spawnPolicy?: SpawnPolicy | undefined;

  /**
   * Filesystem backend configuration. Controls which FileSystemBackend
   * implementation is used.
   *
   * - `undefined`: falls back to `manifest.filesystem` if a manifest is provided.
   * - `FileSystemConfig`: explicitly configures the backend.
   * - `false`: explicitly disables filesystem, overriding any manifest config.
   *   Use this to prevent manifest-supplied filesystem grants from taking effect.
   */
  readonly filesystem?: FileSystemConfig | false | undefined;

  /**
   * Working directory for the local filesystem backend. Required when
   * filesystem.backend is "local" (or absent). Defaults to process.cwd().
   */
  readonly cwd?: string | undefined;
}

/** Default stream timeout: 2 minutes for live API calls. */
export const DEFAULT_STREAM_TIMEOUT_MS = 120_000 as const;

/** Default stream timeout for VCR replay: 5 seconds. */
export const VCR_STREAM_TIMEOUT_MS = 5_000 as const;

// ---------------------------------------------------------------------------
// Debug introspection
// ---------------------------------------------------------------------------

/** Middleware inventory entry for debug introspection. */
export interface MiddlewareDebugEntry {
  readonly name: string;
  readonly phase: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly stubbed: boolean;
}

/** Tool inventory entry for debug introspection. */
export interface ToolDebugEntry {
  readonly name: string;
  readonly source: string;
}

/** Debug introspection handle returned by createRuntime when debug is enabled. */
export interface RuntimeDebugInfo {
  readonly middleware: readonly MiddlewareDebugEntry[];
  readonly tools: readonly ToolDebugEntry[];
  readonly adapter: { readonly name: string; readonly stubbed: boolean };
  readonly channel: { readonly name: string; readonly capabilities: ChannelCapabilities };
}

// ---------------------------------------------------------------------------
// Runtime handle
// ---------------------------------------------------------------------------

/** The assembled runtime returned by createRuntime. */
export interface RuntimeHandle {
  readonly adapter: EngineAdapter;
  readonly channel: ChannelAdapter;
  readonly middleware: readonly KoiMiddleware[];

  /** Debug introspection. Only populated when config.debug is true. */
  readonly debugInfo: RuntimeDebugInfo | undefined;

  /**
   * Trajectory document store for rich execution traces.
   * Only populated when config.trajectoryDir is provided.
   * Shared between harness (writes DebugSpans) and event-trace (writes RichTrajectorySteps).
   */
  readonly trajectoryStore: TrajectoryDocumentStore | undefined;

  /**
   * Spawn tool provider. Only populated when `config.resolver` is provided.
   * Pass this to `createKoi({ providers: [handle.spawnProvider] })` to register
   * the `Spawn` tool and enable agent-to-agent delegation for that agent.
   */
  readonly spawnProvider: ComponentProvider | undefined;

  /**
   * Resolved filesystem backend. Only populated when filesystem is explicitly
   * configured via config.filesystem or manifest.filesystem (opt-in).
   */
  readonly filesystemBackend: FileSystemBackend | undefined;

  /**
   * Filesystem ComponentProvider — registers the backend under FILESYSTEM token
   * and creates fs_read, fs_write, fs_edit tools. Pass to createKoi() providers.
   * Only populated when filesystem is explicitly configured.
   */
  readonly filesystemProvider: ComponentProvider | undefined;

  /** Dispose all resources. */
  readonly dispose: () => Promise<void>;
}
