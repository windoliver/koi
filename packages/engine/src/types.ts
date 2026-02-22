/**
 * L1-specific configuration types for engine guards and factory.
 */

import type {
  Agent,
  AgentManifest,
  ApprovalHandler,
  ComponentProvider,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  KoiMiddleware,
  ProcessAccounter,
  SpawnLedger,
  Tool,
  ToolDescriptor,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Guard configuration
// ---------------------------------------------------------------------------

export interface IterationLimits {
  /** Maximum number of turns before forced termination. */
  readonly maxTurns: number;
  /** Maximum total duration in milliseconds. */
  readonly maxDurationMs: number;
  /** Maximum total tokens (input + output) across all turns. */
  readonly maxTokens: number;
}

export type LoopDetectionKind = "repeat" | "ping_pong" | "no_progress";

export interface LoopWarningInfo {
  readonly toolId: string;
  readonly repeatCount: number;
  readonly windowSize: number;
  readonly warningThreshold: number;
  readonly threshold: number;
  readonly detectionKind?: LoopDetectionKind;
}

export interface LoopDetectionConfig {
  /** Number of recent turn hashes to track. */
  readonly windowSize: number;
  /** Number of repeated hashes within the window to trigger loop detection. */
  readonly threshold: number;
  /** Optional count at which to fire a warning before the hard threshold. Must be < threshold. */
  readonly warningThreshold?: number;
  /** Callback fired when warningThreshold is reached. Requires warningThreshold to be set. */
  readonly onWarning?: (info: LoopWarningInfo) => void;
  /**
   * When true (default), inject a system warning message into the model context
   * when warningThreshold is reached, giving the agent a chance to self-correct.
   * Requires warningThreshold to be set.
   */
  readonly injectWarning?: boolean;
  /** Max number of keys in tool input before falling back to toolId-only fingerprinting. Default: 20. */
  readonly maxInputKeys?: number;
  /** Enable ping-pong (alternating pattern) detection. Default: true. */
  readonly pingPongEnabled?: boolean;
  /** Minimum pattern length for ping-pong detection. Default: 2. */
  readonly pingPongMinPatternLength?: number;
  /** Number of full repetitions required to trigger ping-pong detection. Default: 2. */
  readonly pingPongRepetitions?: number;
  /** Enable no-progress (identical output) detection. Default: true. */
  readonly noProgressEnabled?: boolean;
  /** Number of consecutive identical outputs from the same tool before triggering. Default: 3. */
  readonly noProgressThreshold?: number;
}

export interface SpawnWarningInfo {
  /** Which limit triggered the warning. */
  readonly kind: "fan_out" | "total_processes";
  /** Current count when warning fired. */
  readonly current: number;
  /** Hard limit that will be enforced. */
  readonly limit: number;
  /** Threshold at which this warning was triggered. */
  readonly warningAt: number;
}

/**
 * Spawn governance policy — controls process tree shape and concurrency.
 *
 * **maxDepth vs maxForgeDepth**: These are distinct concepts.
 * - `maxDepth` (here, L1) = how deep the process tree can grow (structural limit).
 * - `maxForgeDepth` (ForgeConfig, L2) = at what depth agents can CREATE new bricks.
 *   Depth 0 agents can use all 6 forge tools, depth 1 can use 4, depth 2+ can only search.
 *
 * Both are intentional — spawn depth limits the hierarchy, forge depth limits capabilities.
 */
export interface SpawnPolicy {
  /**
   * Maximum depth of the process tree (0 = root).
   * This is a structural limit — spawning deeper than this is never retryable.
   * Distinct from ForgeConfig.maxForgeDepth which controls forge CAPABILITY at each depth.
   */
  readonly maxDepth: number;
  /**
   * Maximum number of direct children per agent (fan-out).
   * Transient limit — retryable once a child terminates and releases its slot.
   */
  readonly maxFanOut: number;
  /**
   * Maximum total processes across the entire spawn tree.
   * Enforced via the shared SpawnLedger. Retryable once slots are released.
   */
  readonly maxTotalProcesses: number;
  /**
   * Tool IDs that trigger spawn governance checks.
   * Defaults to DEFAULT_SPAWN_TOOL_IDS (`["forge_agent"]`).
   */
  readonly spawnToolIds?: readonly string[];
  /**
   * Fan-out count at which to fire a pre-limit warning.
   * Must be strictly less than maxFanOut.
   */
  readonly fanOutWarningAt?: number;
  /**
   * Total process count at which to fire a pre-limit warning.
   * Must be strictly less than maxTotalProcesses.
   */
  readonly totalProcessWarningAt?: number;
  /**
   * Synchronous callback when either warning threshold is reached.
   * Fires at most once per limit kind per guard instance.
   */
  readonly onWarning?: (info: SpawnWarningInfo) => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_ITERATION_LIMITS: IterationLimits = Object.freeze({
  maxTurns: 25,
  maxDurationMs: 300_000,
  maxTokens: 100_000,
});

export const DEFAULT_LOOP_DETECTION: LoopDetectionConfig = Object.freeze({
  windowSize: 8,
  threshold: 3,
  pingPongEnabled: true,
  pingPongMinPatternLength: 2,
  pingPongRepetitions: 2,
  noProgressEnabled: true,
  noProgressThreshold: 3,
});

/** Default tool IDs that trigger spawn governance. */
export const DEFAULT_SPAWN_TOOL_IDS: readonly string[] = Object.freeze(["forge_agent"]);

export const DEFAULT_SPAWN_POLICY: SpawnPolicy = Object.freeze({
  maxDepth: 3,
  maxFanOut: 5,
  maxTotalProcesses: 20,
  spawnToolIds: DEFAULT_SPAWN_TOOL_IDS,
});

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
  /** Get currently active forged middleware. Re-queried at turn boundaries. */
  readonly middleware?: () => Promise<readonly KoiMiddleware[]>;
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
   * Shared spawn ledger for tree-wide concurrency tracking.
   * The root agent creates a ledger; children share the same instance.
   * Defaults to an in-memory counter (single-Node scope).
   * Provide a custom implementation for multi-Node/distributed tracking.
   */
  readonly spawnLedger?: SpawnLedger;
  /** Optional approval handler for HITL permission gating. */
  readonly approvalHandler?: ApprovalHandler;
  /** Optional live forge runtime — enables forged tools/middleware without agent re-assembly. */
  readonly forge?: ForgeRuntime;
  /** Optional shared process accounter for cross-agent spawn accounting. */
  readonly processAccounter?: ProcessAccounter;
}

export interface KoiRuntime {
  /** The assembled agent entity. */
  readonly agent: Agent;
  /** Run the agent with the given input. Returns an async iterable of engine events. */
  readonly run: (input: EngineInput) => AsyncIterable<EngineEvent>;
  /** Dispose the runtime and release resources. */
  readonly dispose: () => Promise<void>;
}
