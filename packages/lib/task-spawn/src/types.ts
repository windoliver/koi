/**
 * Task spawn types — lightweight subagent delegation contract.
 *
 * The spawn callback is provided by the consumer (L3/app) so this package
 * stays free of L1 engine imports.
 */

import type {
  AgentId,
  AgentResolver,
  SpawnFn as CoreSpawnFn,
  SpawnRequest as CoreSpawnRequest,
  SpawnResult as CoreSpawnResult,
  KoiError,
  Result,
  TaskableAgent,
  TaskableAgentSummary,
  ToolDescriptor,
} from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export type {
  AgentResolver,
  LiveAgentHandle,
  TaskableAgent,
  TaskableAgentSummary,
} from "@koi/core";

/** Options passed to the spawn callback by the task tool. */
export type TaskSpawnRequest = CoreSpawnRequest;

/**
 * Result returned by the spawn (or message) callback.
 *
 * Accepts both the unified core shape (`error: KoiError`) and the legacy
 * `error: string` shape during the v2 unification migration. The runtime
 * `extractOutput` helper normalizes both. New code should produce the core
 * shape; this widening is a temporary compatibility surface.
 */
export type TaskSpawnResult = CoreSpawnResult | { readonly ok: false; readonly error: string };

/** Spawn callback — wires task-spawn to the L1 lifecycle without an L1 import. */
export type SpawnFn = CoreSpawnFn;

/** Request sent to a live copilot agent via the message path. */
export interface TaskMessageRequest {
  readonly agentId: AgentId;
  readonly description: string;
  readonly signal: AbortSignal;
}

/** Message callback — sends a message to a live copilot instead of spawning. */
export type MessageFn = (request: TaskMessageRequest) => Promise<TaskSpawnResult>;

/** Default maximum duration per task in ms (5 minutes). */
export const DEFAULT_MAX_DURATION_MS = 300_000;

/** Default TTL for descriptor cache in ms (30 seconds). */
export const DEFAULT_DESCRIPTOR_TTL_MS = 30_000;

export interface TaskSpawnConfig {
  readonly agents?: ReadonlyMap<string, TaskableAgent> | undefined;
  readonly agentResolver?: AgentResolver | undefined;
  readonly spawn: SpawnFn;
  readonly defaultAgent?: string | undefined;
  readonly maxDurationMs?: number | undefined;
  readonly message?: MessageFn | undefined;
}

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

export function isTaskSpawnSuccess(
  result: TaskSpawnResult,
): result is { readonly ok: true; readonly output: string } {
  return result.ok === true;
}

export function isTaskSpawnFailure(
  result: TaskSpawnResult,
): result is { readonly ok: false; readonly error: KoiError } {
  return result.ok === false;
}

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
