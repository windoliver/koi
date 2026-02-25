/**
 * Types for the parallel minions system.
 *
 * L2 — imports from @koi/core only.
 */

import type { AgentManifest } from "@koi/core/assembly";
import type { ToolDescriptor } from "@koi/core/ecs";

// ---------------------------------------------------------------------------
// Spawn primitive (own copy — no peer L2 coupling)
// ---------------------------------------------------------------------------

/** Options passed to the spawn callback by the parallel tool. */
export interface MinionSpawnRequest {
  readonly description: string;
  readonly agentName: string;
  readonly manifest: AgentManifest;
  readonly signal: AbortSignal;
  /** Correlation index for matching result to task. */
  readonly taskIndex: number;
}

/** Result returned by the spawn callback. */
export type MinionSpawnResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: string };

/**
 * Spawn callback — the consumer (L3/app) provides this to wire
 * L2 parallel-minions to L1 spawnChildAgent() + runtime.run().
 * Keeps @koi/parallel-minions free of L1 imports.
 */
export type MinionSpawnFn = (request: MinionSpawnRequest) => Promise<MinionSpawnResult>;

// ---------------------------------------------------------------------------
// Task input (what the LLM provides)
// ---------------------------------------------------------------------------

/** A single task in the parallel batch. */
export interface MinionTask {
  readonly description: string;
  readonly agent_type?: string | undefined;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Outcome of a single task within a batch. */
export type MinionOutcome =
  | { readonly ok: true; readonly taskIndex: number; readonly output: string }
  | { readonly ok: false; readonly taskIndex: number; readonly error: string };

/** Summary statistics for a completed batch. */
export interface BatchSummary {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly strategy: ExecutionStrategyKind;
}

/** Complete result of a batch execution. */
export interface BatchResult {
  readonly outcomes: readonly MinionOutcome[];
  readonly summary: BatchSummary;
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

/** FIFO counting semaphore for concurrency control. */
export interface Semaphore {
  readonly acquire: () => Promise<void>;
  readonly release: () => void;
  readonly activeCount: () => number;
}

/** Per-lane concurrency limits. Keys = agent type keys from config.agents. */
export type LaneConcurrency = ReadonlyMap<string, number>;

/** Lane-aware concurrency gate. Superset of Semaphore with optional lane routing. */
export interface ConcurrencyGate {
  readonly acquire: (lane?: string | undefined) => Promise<void>;
  readonly release: (lane?: string | undefined) => void;
  readonly activeCount: (lane?: string | undefined) => number;
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/** Discriminant for execution strategy selection. */
export type ExecutionStrategyKind = "best-effort" | "fail-fast" | "quorum";

/** A strategy function that executes a batch of tasks. */
export type ExecutionStrategy = (ctx: ExecutionContext) => Promise<BatchResult>;

/** Context provided to strategy functions. */
export interface ExecutionContext {
  readonly tasks: readonly ResolvedTask[];
  readonly semaphore: ConcurrencyGate;
  readonly spawn: MinionSpawnFn;
  readonly batchSignal: AbortSignal;
  readonly maxOutputPerTask: number;
  readonly strategy: ExecutionStrategyKind;
}

/** A task with its agent resolved from the config. */
export interface ResolvedTask {
  readonly index: number;
  readonly description: string;
  readonly agentName: string;
  readonly agentType: string;
  readonly manifest: AgentManifest;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** A pre-registered agent type available for parallel task delegation. */
export interface MinionableAgent {
  readonly name: string;
  readonly description: string;
  readonly manifest: AgentManifest;
}

/** Configuration for the parallel minions provider. */
export interface ParallelMinionsConfig {
  /** Pre-registered agent types available for task delegation. */
  readonly agents: ReadonlyMap<string, MinionableAgent>;
  /** Spawn callback — consumer wires to spawnChildAgent() + runtime.run(). */
  readonly spawn: MinionSpawnFn;
  /** Optional default agent type used when agent_type is omitted. */
  readonly defaultAgent?: string | undefined;
  /** Maximum concurrent spawns. Default: 5. */
  readonly maxConcurrency?: number | undefined;
  /** Maximum total duration for the batch in ms. Default: 300_000 (5 min). */
  readonly maxDurationMs?: number | undefined;
  /** Maximum output characters per task. Default: 5_000. */
  readonly maxOutputPerTask?: number | undefined;
  /** Maximum total output characters across all tasks. Default: 50_000. */
  readonly maxTotalOutput?: number | undefined;
  /** Execution strategy. Default: "best-effort". */
  readonly strategy?: ExecutionStrategyKind | undefined;
  /** Required number of successes when strategy = "quorum". */
  readonly quorumThreshold?: number | undefined;
  /** Per-lane concurrency limits. Keys must reference keys in `agents`. */
  readonly laneConcurrency?: LaneConcurrency | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default maximum concurrent spawns. */
export const DEFAULT_MAX_CONCURRENCY = 5;

/** Default maximum duration for the entire batch in ms (5 minutes). */
export const DEFAULT_MAX_DURATION_MS = 300_000;

/** Default maximum output characters per task. */
export const DEFAULT_MAX_OUTPUT_PER_TASK = 5_000;

/** Default maximum total output characters across all tasks. */
export const DEFAULT_MAX_TOTAL_OUTPUT = 50_000;

/** Default execution strategy. */
export const DEFAULT_STRATEGY: ExecutionStrategyKind = "best-effort";

/** Maximum number of tasks in a single batch. */
export const MAX_TASKS_PER_BATCH = 50;

// ---------------------------------------------------------------------------
// Tool descriptor
// ---------------------------------------------------------------------------

/** Tool descriptor exposed to the model for the parallel_task tool. */
export const PARALLEL_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: "parallel_task",
  description:
    "Delegate multiple tasks to specialized subagents running in parallel. Returns aggregated results from all tasks.",
  inputSchema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "List of tasks to execute in parallel",
        items: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "What the subagent should do — clear, self-contained instruction",
            },
            agent_type: {
              type: "string",
              description: "Which agent type to use (optional, defaults to general-purpose)",
            },
          },
          required: ["description"],
        },
      },
    },
    required: ["tasks"],
  },
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Type guard for successful MinionSpawnResult. */
export function isMinionSpawnSuccess(
  result: MinionSpawnResult,
): result is { readonly ok: true; readonly output: string } {
  return result.ok === true;
}

/** Type guard for failed MinionSpawnResult. */
export function isMinionSpawnFailure(
  result: MinionSpawnResult,
): result is { readonly ok: false; readonly error: string } {
  return result.ok === false;
}

/** Type guard for successful MinionOutcome. */
export function isMinionOutcomeSuccess(
  outcome: MinionOutcome,
): outcome is { readonly ok: true; readonly taskIndex: number; readonly output: string } {
  return outcome.ok === true;
}

/** Type guard for failed MinionOutcome. */
export function isMinionOutcomeFailure(
  outcome: MinionOutcome,
): outcome is { readonly ok: false; readonly taskIndex: number; readonly error: string } {
  return outcome.ok === false;
}
