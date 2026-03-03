/**
 * L2 types for @koi/orchestrator — callback signatures, tool descriptors, config.
 */

import type { KoiError, TaskBoardEvent, TaskItemId } from "@koi/core";

// ---------------------------------------------------------------------------
// Callback types (L0-compatible signatures, no L2 imports)
// ---------------------------------------------------------------------------

export interface SpawnWorkerRequest {
  readonly taskId: TaskItemId;
  readonly description: string;
  readonly agentId?: string | undefined;
  readonly signal: AbortSignal;
}

export type SpawnWorkerResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: KoiError };

/** Injected by consumer — spawns a worker agent for a task. */
export type SpawnWorkerFn = (request: SpawnWorkerRequest) => Promise<SpawnWorkerResult>;

export interface VerifyResult {
  readonly verdict: "accept" | "reject" | "revise";
  readonly feedback?: string | undefined;
}

/** Optional verification gate — auto-accept if not provided. */
export type VerifyResultFn = (taskId: TaskItemId, output: string) => Promise<VerifyResult>;

// ---------------------------------------------------------------------------
// Orchestrator config
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  readonly spawn: SpawnWorkerFn;
  readonly verify?: VerifyResultFn | undefined;
  readonly onEvent?: ((event: TaskBoardEvent) => void) | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly maxOutputPerTask?: number | undefined;
  readonly maxDurationMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

interface OrchestratorDefaults {
  readonly maxConcurrency: number;
  readonly maxRetries: number;
  readonly maxOutputPerTask: number;
  readonly maxDurationMs: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorDefaults = Object.freeze({
  maxConcurrency: 5,
  maxRetries: 3,
  maxOutputPerTask: 5000,
  maxDurationMs: 1_800_000,
});

// ---------------------------------------------------------------------------
// Tool descriptors (constants for tool registration)
// ---------------------------------------------------------------------------

interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
}

export const ORCHESTRATE_TOOL_DESCRIPTOR: ToolDescriptor = Object.freeze({
  name: "orchestrate",
  description:
    "Manage the task board: add tasks with dependencies, query board status, or update tasks. " +
    "Use action 'add' to add tasks, 'query' to inspect board state, 'update' to modify a task.",
});

export const ASSIGN_WORKER_TOOL_DESCRIPTOR: ToolDescriptor = Object.freeze({
  name: "assign_worker",
  description:
    "Assign a ready task to a worker agent. The worker will be spawned to execute the task. " +
    "Only tasks with all dependencies completed can be assigned.",
});

export const REVIEW_OUTPUT_TOOL_DESCRIPTOR: ToolDescriptor = Object.freeze({
  name: "review_output",
  description:
    "Review a completed task's output. Verdict: 'accept' to keep, 'reject' to fail and retry, " +
    "'revise' to retry with feedback.",
});

export const SYNTHESIZE_TOOL_DESCRIPTOR: ToolDescriptor = Object.freeze({
  name: "synthesize",
  description:
    "Synthesize all completed task results into a final output. " +
    "Results are ordered by dependency (topological order).",
});
