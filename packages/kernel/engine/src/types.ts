/**
 * L1-specific configuration types for the engine factory and spawn.
 *
 * Guard types are re-exported from @koi/engine-compose.
 * Governance types are re-exported from @koi/engine-reconcile.
 */

import type {
  Agent,
  AgentGroupId,
  AgentManifest,
  AgentRegistry,
  ApprovalHandler,
  BrickComponentMap,
  BrickKind,
  ChannelStatus,
  ChildHandle,
  ComponentProvider,
  DelegationId,
  DeliveryPolicy,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  ForgeScope,
  KernelExtension,
  KoiMiddleware,
  ProcessAccounter,
  ProcessId,
  SpawnChannelPolicy,
  SpawnLedger,
  StoreChangeEvent,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import type { IterationLimits, LoopDetectionConfig, SpawnPolicy } from "@koi/engine-compose";
import type { GovernanceConfig } from "@koi/engine-reconcile";
import type { AssemblyConflict } from "./agent-entity.js";

// ---------------------------------------------------------------------------
// Live forge resolution
// ---------------------------------------------------------------------------

/**
 * Enables forged capabilities to be used without agent re-assembly.
 *
 * Tools: resolved at call time (immediate). Descriptors refreshed at turn boundary.
 * Middleware: re-composed at turn boundary (next turn picks up new middleware).
 *
 * All methods use L0 types only — L2 (forge) provides the implementation.
 */
export interface ForgeRuntime {
  /** Resolve a forged tool by name. Returns undefined if not found or not accessible. */
  readonly resolveTool: (toolId: string) => Promise<Tool | undefined>;
  /** Get descriptors for all currently available forged tools. */
  readonly toolDescriptors: () => Promise<readonly ToolDescriptor[]>;
  /**
   * Get currently active forged middleware. Re-queried at turn boundaries.
   * Forged middleware participates in wrapper hooks only (wrapModelCall, wrapModelStream,
   * wrapToolCall). It does NOT participate in lifecycle hooks (onSessionStart/End,
   * onBeforeTurn/AfterTurn) or describeCapabilities.
   */
  readonly middleware?: () => Promise<readonly KoiMiddleware[]>;
  /** Push notification when forged capabilities change. Returns unsubscribe. */
  readonly watch?: (listener: (event: StoreChangeEvent) => void) => () => void;
  /** Generic per-kind resolution. Optional for backward compatibility. */
  readonly resolve?: <K extends BrickKind>(
    kind: K,
    name: string,
  ) => Promise<BrickComponentMap[K] | undefined>;
}

// ---------------------------------------------------------------------------
// Factory API
// ---------------------------------------------------------------------------

export interface CreateKoiOptions {
  /** The agent manifest describing the agent's configuration. */
  readonly manifest: AgentManifest;
  /** The engine adapter that provides the agent loop. */
  readonly adapter: EngineAdapter;
  /** Additional middleware to compose (L2 middleware). Order matters — first runs outermost. */
  readonly middleware?: readonly KoiMiddleware[];
  /** Component providers to attach during assembly. */
  readonly providers?: readonly ComponentProvider[];
  /** Iteration guard limits. Defaults to DEFAULT_ITERATION_LIMITS. */
  readonly limits?: Partial<IterationLimits>;
  /** Loop detection configuration. Defaults to DEFAULT_LOOP_DETECTION. Set to false to disable. */
  readonly loopDetection?: Partial<LoopDetectionConfig> | false;
  /** Spawn governance policy. Defaults to DEFAULT_SPAWN_POLICY. */
  readonly spawn?: Partial<SpawnPolicy>;
  /**
   * Kernel extensions for pluggable guards, lifecycle validation, and assembly validation.
   * Extensions are composed with the default guard extension (created from limits/loopDetection/spawn).
   */
  readonly extensions?: readonly KernelExtension[];
  /**
   * Shared spawn ledger for tree-wide concurrency tracking.
   * The root agent creates a ledger; children share the same instance.
   * Defaults to an in-memory counter (single-Node scope).
   * Provide a custom implementation for multi-Node/distributed tracking.
   */
  readonly spawnLedger?: SpawnLedger;
  /** Governance controller configuration. Defaults to DEFAULT_GOVERNANCE_CONFIG. */
  readonly governance?: Partial<GovernanceConfig>;
  /** Optional approval handler for HITL permission gating. */
  readonly approvalHandler?: ApprovalHandler;
  /** Optional live forge runtime — enables forged tools/middleware without agent re-assembly. */
  readonly forge?: ForgeRuntime;
  /**
   * Optional callback returning dynamic middleware (e.g., debug middleware).
   * Queried at turn boundaries. When the returned reference changes (identity check),
   * middleware chains are re-composed to include the dynamic middleware.
   */
  readonly dynamicMiddleware?: (() => readonly KoiMiddleware[] | undefined) | undefined;
  /** Optional shared process accounter for cross-agent spawn accounting. */
  readonly processAccounter?: ProcessAccounter;
  /** Optional status handler for turn lifecycle notifications. L1 threads this into TurnContext. */
  readonly sendStatus?: (status: ChannelStatus) => Promise<void>;
  /** Parent process ID. When provided, child PID is generated with parent reference. */
  readonly parentPid?: ProcessId;
  /** Registry for agent lifecycle tracking. If provided, agent is registered on creation. */
  readonly registry?: AgentRegistry;
  /** Authenticated user identity. Injected into SessionContext. */
  readonly userId?: string;
  /** Channel adapter package name (e.g. "@koi/channel-telegram"). Injected into SessionContext. */
  readonly channelId?: string;
  /** Process group to assign this agent to. Recorded in the registry entry and ProcessId. */
  readonly groupId?: AgentGroupId | undefined;
}

export interface KoiRuntime {
  /** The assembled agent entity. */
  readonly agent: Agent;
  /** Component key conflicts detected during assembly. Empty when no keys collide. */
  readonly conflicts: readonly AssemblyConflict[];
  /** Run the agent with the given input. Returns an async iterable of engine events. */
  readonly run: (input: EngineInput) => AsyncIterable<EngineEvent>;
  /** Dispose the runtime and release resources. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Spawn inheritance config
// ---------------------------------------------------------------------------

/** Unified inheritance configuration for spawned child agents. */
export interface SpawnInheritanceConfig {
  /** Tool scope filtering for inherited tools. */
  readonly tools?: {
    readonly scopeChecker?: (toolName: string) => ForgeScope | undefined;
  };
  /** Channel inheritance policy. */
  readonly channels?: SpawnChannelPolicy;
  /** Environment variable inheritance with overrides. */
  readonly env?: {
    /** Key-value overrides. Set value to undefined to narrow (remove) a parent key. */
    readonly overrides?: Readonly<Record<string, string | undefined>>;
  };
  /** Priority for the child agent (0-39, default 10). */
  readonly priority?: number;
}

// ---------------------------------------------------------------------------
// Spawn child types
// ---------------------------------------------------------------------------

/**
 * Options for spawning a child agent via `spawnChildAgent()`.
 *
 * Ledger management is tied to child lifetime (released on termination),
 * unlike the spawn guard's fan-out which is tied to tool call duration.
 */
export interface SpawnChildOptions {
  /** The parsed agent manifest for the child. */
  readonly manifest: AgentManifest;
  /** The engine adapter for the child's agent loop. Caller provides explicitly. */
  readonly adapter: EngineAdapter;
  /** The parent agent entity (used for component inheritance). */
  readonly parentAgent: Agent;
  /** Shared spawn ledger for tree-wide process tracking. */
  readonly spawnLedger: SpawnLedger;
  /** Spawn governance policy. Used for depth/fan-out validation. */
  readonly spawnPolicy: SpawnPolicy;
  /** Registry for lifecycle tracking. If provided, child is registered with parentId. */
  readonly registry?: AgentRegistry;
  /** Additional middleware for the child. */
  readonly middleware?: readonly KoiMiddleware[];
  /** Additional component providers for the child (beyond inherited). */
  readonly providers?: readonly ComponentProvider[];
  /** Optional forge runtime for the child. */
  readonly forge?: ForgeRuntime;
  /**
   * Optional scope checker for filtering inherited tools.
   * @deprecated Use `inheritance.tools.scopeChecker` instead.
   */
  readonly scopeChecker?: (toolName: string) => ForgeScope | undefined;
  /** Unified inheritance configuration for tools, channels, env, and priority. */
  readonly inheritance?: SpawnInheritanceConfig;
  /** Iteration limits for the child. */
  readonly limits?: Partial<IterationLimits>;
  /** Loop detection config for the child. Set to false to disable. */
  readonly loopDetection?: Partial<LoopDetectionConfig> | false;
  /** Kernel extensions for the child. */
  readonly extensions?: readonly KernelExtension[];
  /** Process group to assign this child to. Recorded in the registry entry. */
  readonly groupId?: AgentGroupId | undefined;
  /**
   * Grace period in milliseconds for TERM signal.
   * After aborting the abort controller, wait this long before forcing termination.
   * Defaults to 5000ms.
   */
  readonly gracePeriodMs?: number | undefined;
  /**
   * Delivery policy override for this spawn.
   * Takes precedence over manifest.delivery when resolving the effective policy.
   */
  readonly delivery?: DeliveryPolicy | undefined;
}

/**
 * Result of spawning a child agent.
 * The caller decides whether to run the child synchronously or asynchronously.
 *
 * Named SpawnChildResult to disambiguate from L0's SpawnResult (unified spawn outcome).
 */
export interface SpawnChildResult {
  /** The child's KoiRuntime. Caller invokes `runtime.run()` to start execution. */
  readonly runtime: KoiRuntime;
  /** Lifecycle handle for monitoring the child. Fires events on start/terminate. */
  readonly handle: ChildHandle;
  /** The child's process ID (convenience — also available as runtime.agent.pid). */
  readonly childPid: ProcessId;
  /**
   * Per-child delegated Nexus API key — attenuated credential from parent delegation.
   * Present when delegation uses a Nexus backend (proof.kind === "nexus").
   * Callers spawning external processes (Temporal, sandbox) must pass this key
   * to the child's env as NEXUS_API_KEY. In-process children inherit the
   * parent's DELEGATION component and don't need this directly.
   */
  readonly nexusApiKey?: string;
  /** Delegation ID for this child, if auto-delegation was performed. */
  readonly delegationId?: DelegationId;
}
