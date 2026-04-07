import type { JsonObject, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskItemId } from "@koi/core";

import { toJSONSchema, z } from "zod";
import type { SpawnToolsConfig } from "../types.js";

const schema = z.object({
  agent_name: z
    .string()
    .min(1)
    .describe(
      "Name of the agent definition to spawn (e.g. 'researcher', 'coder', 'reviewer'). " +
        "Must match a built-in or project-defined agent.",
    ),
  description: z
    .string()
    .min(1)
    .describe("Clear description of the work this child agent should perform."),
  task_id: z
    .string()
    .optional()
    .describe(
      "Optional board task ID. If provided, the task must already be delegated via task_delegate. " +
        "Links the spawn to a tracked board entry for result correlation. " +
        "NOTE: the child's runtime identity is engine-assigned and will not match task.assignedTo — " +
        "child task_update calls require a separate identity-handoff mechanism (see #1416).",
    ),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional structured context passed to the child agent as additional input."),
});

/**
 * agent_spawn — LLM-callable tool for coordinator agents.
 *
 * Spawns a named child agent to complete a specific task. The child runs
 * asynchronously and returns its final output string.
 *
 * Requires the task to already be delegated on the board:
 *   1. Call task_create to register the task.
 *   2. Call task_delegate to assign it to a child agent.
 *   3. Call agent_spawn with the task_id — this enforces the delegation precondition.
 */
export function createAgentSpawnTool(config: SpawnToolsConfig): Tool {
  return {
    descriptor: {
      name: "agent_spawn",
      description:
        "Spawn a named child agent to complete a task. " +
        "Returns the child agent's final output as a string. " +
        "If task_id is provided, the task must have been delegated via task_delegate first " +
        "so the spawn can be correlated back to the board entry.",
      inputSchema: toJSONSchema(schema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }

      const { agent_name, description, task_id } = parsed.data;

      // When task_id is provided, enforce that task_delegate was called first.
      // task_id is optional — omit it for ad-hoc spawns that don't need board tracking.
      if (task_id !== undefined) {
        const taskId = taskItemId(task_id);
        const task = config.board.snapshot().get(taskId);
        if (task === undefined) {
          return {
            ok: false,
            error: `Task '${task_id}' not found on the board. Call task_create first.`,
            code: "NOT_FOUND",
          };
        }
        if (task.assignedTo === undefined) {
          return {
            ok: false,
            error: `Task '${task_id}' has not been delegated. Call task_delegate first.`,
            code: "PRECONDITION_FAILED",
          };
        }
        // Known gap: task.assignedTo is the coordinator-chosen agent name/id, but the
        // child's runtime AgentId is engine-generated and won't match. Child task_update
        // calls will be rejected by the board's assignedTo ownership check.
        // Full fix requires engine-level identity handoff — tracked in #1416.
      }

      const result = await config.spawnFn({
        agentName: agent_name,
        description,
        signal: config.signal,
        ...(task_id !== undefined ? { taskId: taskItemId(task_id) } : {}),
        agentId: config.agentId,
      });

      if (!result.ok) {
        return { ok: false, error: result.error.message };
      }

      return { ok: true, output: result.output };
    },
  };
}
