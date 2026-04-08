import type { JsonObject, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";

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
 * Design: agent_spawn and task_delegate are intentionally independent.
 * For simple use, the coordinator calls agent_spawn directly (like CC's Agent
 * tool). For autonomous/swarm use (#1553), a bridge component (like v1's
 * dispatchSpawnTasks) couples them: task_delegate → agent_spawn → auto-complete.
 * The bridge is a separate layer, not baked into these tools.
 */
export function createAgentSpawnTool(config: SpawnToolsConfig): Tool {
  return {
    descriptor: {
      name: "agent_spawn",
      description:
        "Spawn a named child agent to complete a task. " +
        "Returns the child agent's final output as a string.",
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

      const { agent_name, description } = parsed.data;

      const result = await config.spawnFn({
        agentName: agent_name,
        description,
        signal: config.signal,
        agentId: config.agentId,
      });

      if (!result.ok) {
        return { ok: false, error: result.error.message };
      }

      return { ok: true, output: result.output };
    },
  };
}
