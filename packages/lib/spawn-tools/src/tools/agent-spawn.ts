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
      "Optional task ID to associate with this spawn. " +
        "Use task_delegate first to mark the task on the board, then pass its ID here.",
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
 * asynchronously and returns its final output string. Use task_delegate
 * before agent_spawn to mark the corresponding task as delegated on the board.
 */
export function createAgentSpawnTool(config: SpawnToolsConfig): Tool {
  return {
    descriptor: {
      name: "agent_spawn",
      description:
        "Spawn a named child agent to complete a specific task. " +
        "Returns the child agent's final output as a string. " +
        "Call task_delegate first to mark the task as delegated on the board, " +
        "then pass its task_id here so the child's result can be matched back.",
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
