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
    .min(1)
    .describe(
      "Board task ID to associate with this spawn. " +
        "Call task_create then task_delegate first — this links the child agent's result back to the board entry.",
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
        "Spawn a named child agent for a board-tracked task. " +
        "Returns the child agent's final output as a string. " +
        "Requires task_delegate to have been called first: the task must already be " +
        "assigned on the board before spawning so the result can be matched back.",
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
      const taskId = taskItemId(task_id);

      // Enforce the delegation precondition: task_delegate must have been called first.
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

      const result = await config.spawnFn({
        agentName: agent_name,
        description,
        signal: config.signal,
        taskId,
        agentId: config.agentId,
      });

      if (!result.ok) {
        return { ok: false, error: result.error.message };
      }

      return { ok: true, output: result.output };
    },
  };
}
