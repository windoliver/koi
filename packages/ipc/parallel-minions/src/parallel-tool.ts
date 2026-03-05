/**
 * Parallel tool factory — creates a Tool that delegates multiple tasks to subagents.
 */

import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type { Tool } from "@koi/core/ecs";
import { executeBatch } from "./executor.js";
import { formatBatchResult } from "./output.js";
import type { MinionTask, ParallelMinionsConfig } from "./types.js";
import {
  DEFAULT_MAX_TOTAL_OUTPUT,
  MAX_TASKS_PER_BATCH,
  PARALLEL_TOOL_DESCRIPTOR,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parses and validates the tasks array from tool input.
 * Returns the validated tasks or an error message string.
 */
function parseTasks(args: JsonObject): readonly MinionTask[] | string {
  const rawTasks = args.tasks;
  if (!Array.isArray(rawTasks)) {
    return "Error: 'tasks' is required and must be an array";
  }

  if (rawTasks.length === 0) {
    return "Error: 'tasks' must contain at least one task";
  }

  if (rawTasks.length > MAX_TASKS_PER_BATCH) {
    return `Error: maximum ${MAX_TASKS_PER_BATCH} tasks per batch, got ${rawTasks.length}`;
  }

  const tasks: MinionTask[] = [];
  for (const [i, item] of rawTasks.entries()) {
    if (!isRecord(item)) {
      return `Error: tasks[${i}] must be an object with a 'description' string`;
    }
    if (typeof item.description !== "string" || item.description.length === 0) {
      return `Error: tasks[${i}].description is required and must be a non-empty string`;
    }

    const agentType =
      typeof item.agent_type === "string" && item.agent_type.length > 0
        ? item.agent_type
        : undefined;

    tasks.push({ description: item.description, agent_type: agentType });
  }

  return tasks;
}

/**
 * Creates the `parallel_task` tool for parallel subagent delegation.
 *
 * Flow:
 * 1. Parse input → extract `tasks` array
 * 2. Validate task count (1..50)
 * 3. Call executeBatch() with configured strategy
 * 4. Format results as structured markdown
 * 5. Return formatted string
 */
export function createParallelTool(config: ParallelMinionsConfig): Tool {
  const maxTotalOutput = config.maxTotalOutput ?? DEFAULT_MAX_TOTAL_OUTPUT;

  return {
    descriptor: PARALLEL_TOOL_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,

    async execute(args: JsonObject): Promise<unknown> {
      const parsed = parseTasks(args);
      if (typeof parsed === "string") {
        return parsed;
      }

      const result = await executeBatch(config, parsed);
      return formatBatchResult(result, parsed, maxTotalOutput);
    },
  };
}
