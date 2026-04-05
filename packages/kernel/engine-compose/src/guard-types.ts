/**
 * Guard configuration types — iteration limits, loop detection, and spawn policy.
 */

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
  /**
   * Depth-based tool restrictions. Each rule denies a specific tool at
   * agents with depth >= minDepth. Rules are additive (union of denials).
   * Applies to ALL tool calls, not just spawn tools.
   * Defaults to undefined (no restrictions).
   */
  readonly toolRestrictions?: readonly DepthToolRule[];
}

/**
 * A single depth-based tool restriction rule.
 *
 * Semantics: deny `toolId` at `agentDepth >= minDepth`.
 * Once denied at depth N, the tool remains denied at all deeper depths
 * (object-capability endowment rule: capabilities only narrow with depth).
 */
export interface DepthToolRule {
  /** The tool ID to restrict. */
  readonly toolId: string;
  /** Minimum agent depth at which this tool is denied (inclusive). */
  readonly minDepth: number;
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
export const DEFAULT_SPAWN_TOOL_IDS: readonly string[] = Object.freeze(["forge_agent", "Spawn"]);

export const DEFAULT_SPAWN_POLICY: SpawnPolicy = Object.freeze({
  maxDepth: 3,
  maxFanOut: 5,
  maxTotalProcesses: 20,
  spawnToolIds: DEFAULT_SPAWN_TOOL_IDS,
});

// ---------------------------------------------------------------------------
// Tool execution config
// ---------------------------------------------------------------------------

export interface ToolExecutionConfig {
  /** Global timeout for all tool calls in milliseconds. Default: 120_000 (2 min). */
  readonly defaultTimeoutMs?: number | undefined;
  /** Per-tool timeout overrides. Takes precedence over defaultTimeoutMs. */
  readonly toolTimeouts?: Readonly<Record<string, number>> | undefined;
}

export const DEFAULT_TOOL_EXECUTION: ToolExecutionConfig = Object.freeze({
  defaultTimeoutMs: 120_000,
});
