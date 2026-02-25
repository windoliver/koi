/**
 * Task tool factory — creates a Tool that delegates work to subagents.
 */

import type { JsonObject } from "@koi/core/common";
import type { Tool } from "@koi/core/ecs";
import { extractOutput } from "./output.js";
import { DEFAULT_MAX_DURATION_MS, TASK_TOOL_DESCRIPTOR, type TaskSpawnConfig } from "./types.js";

/**
 * Creates the `task` tool for subagent delegation.
 *
 * Flow:
 * 1. Parse input → extract `description` and `agent_type`
 * 2. Resolve agent from config.agents (fall back to config.defaultAgent)
 * 3. Create AbortController with timeout
 * 4. Call config.spawn() with the resolved manifest + signal
 * 5. Return extracted output as tool result
 *
 * Error boundary:
 * - config.spawn throws → re-throw (governance/infra failure)
 * - config.spawn returns { ok: false } → return error as tool result string
 * - config.spawn returns { ok: true } → return output as tool result
 */
export function createTaskTool(config: TaskSpawnConfig): Tool {
  const maxDurationMs = config.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

  return {
    descriptor: TASK_TOOL_DESCRIPTOR,
    trustTier: "verified",

    async execute(args: JsonObject): Promise<unknown> {
      const description = args.description;
      if (typeof description !== "string" || description.length === 0) {
        return "Error: 'description' is required and must be a non-empty string";
      }

      const agentType =
        typeof args.agent_type === "string" && args.agent_type.length > 0
          ? args.agent_type
          : config.defaultAgent;

      if (agentType === undefined) {
        return "Error: 'agent_type' is required when no default agent is configured";
      }

      const agent = config.agents.get(agentType);
      if (agent === undefined) {
        const available = [...config.agents.keys()].join(", ");
        return `Error: unknown agent type '${agentType}'. Available: ${available}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort("timeout");
      }, maxDurationMs);

      try {
        const result = await config.spawn({
          description,
          agentName: agent.name,
          manifest: agent.manifest,
          signal: controller.signal,
        });

        return extractOutput(result);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
