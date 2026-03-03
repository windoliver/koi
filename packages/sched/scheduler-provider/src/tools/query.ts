/**
 * Tool factory for `scheduler_query` — query scheduled tasks.
 */

import type {
  JsonObject,
  SchedulerComponent,
  TaskFilter,
  TaskStatus,
  Tool,
  TrustTier,
} from "@koi/core";
import { DEFAULT_QUERY_DEFAULT, DEFAULT_QUERY_LIMIT } from "../constants.js";
import { parseOptionalEnum, parseOptionalNumber } from "../parse-args.js";

export function createQueryTool(
  component: SchedulerComponent,
  prefix: string,
  trustTier: TrustTier,
  queryLimit: number = DEFAULT_QUERY_LIMIT,
  queryDefault: number = DEFAULT_QUERY_DEFAULT,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_query`,
      description: `Query scheduled tasks. Results clamped to max ${queryLimit}.`,
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "running", "completed", "failed", "dead_letter"],
            description: "Filter by task status",
          },
          priority: {
            type: "number",
            description: "Filter by priority level",
          },
          limit: {
            type: "number",
            description: `Max results to return (default: ${queryDefault}, max: ${queryLimit})`,
          },
        },
        required: [],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const statusResult = parseOptionalEnum(args, "status", [
        "pending",
        "running",
        "completed",
        "failed",
        "dead_letter",
      ] as const);
      if (!statusResult.ok) return statusResult.err;

      const priorityResult = parseOptionalNumber(args, "priority");
      if (!priorityResult.ok) return priorityResult.err;

      const limitResult = parseOptionalNumber(args, "limit");
      if (!limitResult.ok) return limitResult.err;

      // Clamp limit to max
      const requestedLimit = limitResult.value ?? queryDefault;
      const clampedLimit = Math.min(Math.max(1, requestedLimit), queryLimit);

      const filter: TaskFilter = {
        ...(statusResult.value !== undefined && { status: statusResult.value as TaskStatus }),
        ...(priorityResult.value !== undefined && { priority: priorityResult.value }),
        limit: clampedLimit,
      };

      try {
        const tasks = await component.query(filter);
        return { tasks, count: tasks.length };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
