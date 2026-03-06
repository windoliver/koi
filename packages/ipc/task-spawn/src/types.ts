/**
 * Types for the task spawn system.
 *
 * L2 — imports from @koi/core only.
 */

import type { DeliveryPolicy } from "@koi/core";
import type { AgentManifest } from "@koi/core/assembly";
import type { AgentId, ToolDescriptor } from "@koi/core/ecs";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

// Re-export L0 types for backward compatibility
export type {
  AgentResolver,
  LiveAgentHandle,
  TaskableAgent,
  TaskableAgentSummary,
} from "@koi/core/agent-resolver";

// Import for local use
import type { AgentResolver, TaskableAgent, TaskableAgentSummary } from "@koi/core/agent-resolver";

/** Options passed to the spawn callback by the task tool. */
export interface TaskSpawnRequest {
  readonly description: string;
  readonly agentName: string;
  readonly manifest: AgentManifest;
  readonly signal: AbortSignal;
  /** Delivery policy override for this spawn. */
  readonly delivery?: DeliveryPolicy | undefined;
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

/** Request sent to a live copilot agent via the message path. */
export interface TaskMessageRequest {
  readonly agentId: AgentId;
  readonly description: string;
  readonly signal: AbortSignal;
}

/**
 * Message callback — sends a message to an already-running copilot agent
 * instead of spawning a new worker.
 */
export type MessageFn = (request: TaskMessageRequest) => Promise<TaskSpawnResult>;

/** Default maximum duration per task in ms (5 minutes). */
export const DEFAULT_MAX_DURATION_MS = 300_000;

/** Configuration for the task spawn provider. */
export interface TaskSpawnConfig {
  /** Pre-registered agent types available for task delegation. */
  readonly agents?: ReadonlyMap<string, TaskableAgent> | undefined;
  /** Dynamic agent resolver (alternative to static `agents` map). */
  readonly agentResolver?: AgentResolver | undefined;
  /** Spawn callback — consumer wires to spawnChildAgent() + runtime.run(). */
  readonly spawn: SpawnFn;
  /** Optional default agent type used when agent_type is omitted. */
  readonly defaultAgent?: string | undefined;
  /** Maximum duration per task in ms. Default: 300_000 (5 min). */
  readonly maxDurationMs?: number | undefined;
  /** Optional message callback for routing to live copilot agents. */
  readonly message?: MessageFn | undefined;
}

/** Creates a ToolDescriptor with agent_type enum populated from summaries. */
export function createTaskToolDescriptor(
  summaries: readonly TaskableAgentSummary[],
): ToolDescriptor {
  const agentTypeProperty: Readonly<Record<string, unknown>> =
    summaries.length > 0
      ? {
          type: "string",
          enum: summaries.map((s) => s.key),
          description: summaries.map((s) => `${s.key}: ${s.description}`).join("\n"),
        }
      : {
          type: "string",
          description: "Which agent type to use (optional, defaults to general-purpose)",
        };

  return {
    name: "task",
    description: "Delegate a task to a specialized subagent. Returns the agent's final response.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "What the subagent should do — clear, self-contained instruction",
        },
        agent_type: agentTypeProperty,
      },
      required: ["description"],
    },
  };
}

/** Tool descriptor exposed to the model for the task tool (no agent enum). */
export const TASK_TOOL_DESCRIPTOR: ToolDescriptor = createTaskToolDescriptor([]);

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

/** Creates an AgentResolver backed by a static ReadonlyMap (backward compat). */
export function createMapAgentResolver(agents: ReadonlyMap<string, TaskableAgent>): AgentResolver {
  const summaries: readonly TaskableAgentSummary[] = [...agents.entries()].map(([key, agent]) => ({
    key,
    name: agent.name,
    description: agent.description,
  }));

  return {
    resolve(agentType: string): Result<TaskableAgent, KoiError> {
      const agent = agents.get(agentType);
      if (agent === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Unknown agent type '${agentType}'`,
            retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
          },
        };
      }
      return { ok: true, value: agent };
    },
    list(): readonly TaskableAgentSummary[] {
      return summaries;
    },
  };
}
