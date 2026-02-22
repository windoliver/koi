/**
 * L1-specific configuration types for engine guards and factory.
 */

import type {
  AgentManifest,
  ApprovalHandler,
  ComponentProvider,
  EngineAdapter,
  KoiMiddleware,
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

export interface LoopWarningInfo {
  readonly toolId: string;
  readonly repeatCount: number;
  readonly windowSize: number;
  readonly warningThreshold: number;
  readonly threshold: number;
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
}

export interface SpawnPolicy {
  /** Maximum depth of the process tree (0 = root). */
  readonly maxDepth: number;
  /** Maximum number of children per agent. */
  readonly maxFanOut: number;
  /** Maximum total processes across the entire tree. */
  readonly maxTotalProcesses: number;
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
});

export const DEFAULT_SPAWN_POLICY: SpawnPolicy = Object.freeze({
  maxDepth: 3,
  maxFanOut: 5,
  maxTotalProcesses: 20,
});

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
  /** Optional approval handler for HITL permission gating. */
  readonly approvalHandler?: ApprovalHandler;
}

import type { Agent, EngineEvent, EngineInput } from "@koi/core";

export interface KoiRuntime {
  /** The assembled agent entity. */
  readonly agent: Agent;
  /** Run the agent with the given input. Returns an async iterable of engine events. */
  readonly run: (input: EngineInput) => AsyncIterable<EngineEvent>;
  /** Dispose the runtime and release resources. */
  readonly dispose: () => Promise<void>;
}
