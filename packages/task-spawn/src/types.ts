/**
 * Types for the task spawn system.
 *
 * L2 — imports from @koi/core only.
 */

import type { AgentManifest } from "@koi/core/assembly";
import type { ToolDescriptor } from "@koi/core/ecs";

/** A pre-registered agent type available for task delegation. */
export interface TaskableAgent {
  readonly name: string;
  readonly description: string;
  readonly manifest: AgentManifest;
}

/** Options passed to the spawn callback by the task tool. */
export interface TaskSpawnRequest {
  readonly description: string;
  readonly agentName: string;
  readonly manifest: AgentManifest;
  readonly signal: AbortSignal;
}

/** Result returned by the spawn callback. */
export type TaskSpawnResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: string };

/**
 * Spawn callback — the consumer (L3/app) provides this to wire
 * L2 task-spawn to L1 spawnChildAgent() + runtime.run().
 * This keeps @koi/task-spawn free of L1 imports.
 */
export type SpawnFn = (request: TaskSpawnRequest) => Promise<TaskSpawnResult>;

/** Default maximum duration per task in ms (5 minutes). */
export const DEFAULT_MAX_DURATION_MS = 300_000;

/** Configuration for the task spawn provider. */
export interface TaskSpawnConfig {
  /** Pre-registered agent types available for task delegation. */
  readonly agents: ReadonlyMap<string, TaskableAgent>;
  /** Spawn callback — consumer wires to spawnChildAgent() + runtime.run(). */
  readonly spawn: SpawnFn;
  /** Optional default agent type used when agent_type is omitted. */
  readonly defaultAgent?: string | undefined;
  /** Maximum duration per task in ms. Default: 300_000 (5 min). */
  readonly maxDurationMs?: number | undefined;
}

/** Tool descriptor exposed to the model for the task tool. */
export const TASK_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: "task",
  description: "Delegate a task to a specialized subagent. Returns the agent's final response.",
  inputSchema: {
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
};

/** Type guard for TaskSpawnResult. */
export function isTaskSpawnSuccess(
  result: TaskSpawnResult,
): result is { readonly ok: true; readonly output: string } {
  return result.ok === true;
}

/** Type guard for TaskSpawnResult failure. */
export function isTaskSpawnFailure(
  result: TaskSpawnResult,
): result is { readonly ok: false; readonly error: string } {
  return result.ok === false;
}
