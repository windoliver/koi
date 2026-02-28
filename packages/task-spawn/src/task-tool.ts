/**
 * Task tool factory — creates a Tool that delegates work to subagents.
 */

import type { JsonObject } from "@koi/core/common";
import type { Tool } from "@koi/core/ecs";
import { extractOutput } from "./output.js";
import {
  type AgentResolver,
  createMapAgentResolver,
  createTaskToolDescriptor,
  DEFAULT_MAX_DURATION_MS,
  TASK_TOOL_DESCRIPTOR,
  type TaskSpawnConfig,
} from "./types.js";

/**
 * Resolves the effective AgentResolver from config.
 * Prefers explicit agentResolver; falls back to creating one from agents map.
 */
function resolveAgentResolver(config: TaskSpawnConfig): AgentResolver {
  if (config.agentResolver !== undefined) {
    return config.agentResolver;
  }
  if (config.agents !== undefined) {
    return createMapAgentResolver(config.agents);
  }
  throw new Error("TaskSpawnConfig requires either 'agents' or 'agentResolver'");
}

/**
 * Creates the `task` tool for subagent delegation.
 *
 * Flow:
 * 1. Build dynamic descriptor from agent summaries
 * 2. Parse input → extract `description` and `agent_type`
 * 3. Resolve agent via AgentResolver (may be async)
 * 4. Create AbortController with timeout
 * 5. Call config.spawn() with the resolved manifest + signal
 * 6. Return extracted output as tool result
 */
export async function createTaskTool(config: TaskSpawnConfig): Promise<Tool> {
  const maxDurationMs = config.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const resolver = resolveAgentResolver(config);
  const summaries = await Promise.resolve(resolver.list());
  const descriptor =
    summaries.length > 0 ? createTaskToolDescriptor(summaries) : TASK_TOOL_DESCRIPTOR;

  return {
    descriptor,
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

      const agent = await Promise.resolve(resolver.resolve(agentType));
      if (agent === undefined) {
        const available = summaries.map((s) => s.key).join(", ");
        return `Error: unknown agent type '${agentType}'. Available: ${available}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort("timeout");
      }, maxDurationMs);

      try {
        // Copilot path: if a live agent of this type exists, message it instead of spawning
        if (config.message !== undefined && resolver.findLive !== undefined) {
          const liveId = await Promise.resolve(resolver.findLive(agentType));
          if (liveId !== undefined) {
            const result = await config.message({
              agentId: liveId,
              description,
              signal: controller.signal,
            });
            return extractOutput(result);
          }
        }

        // Spawn path: create a new worker agent
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
