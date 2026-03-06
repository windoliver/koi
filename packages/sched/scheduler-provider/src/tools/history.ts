/**
 * Tool factory for `scheduler_history` — query task execution history.
 *
 * agentId is auto-pinned (same pattern as query tool) so agents
 * can only see their own execution history.
 */

import type {
  JsonObject,
  SchedulerComponent,
  TaskHistoryFilter,
  Tool,
  ToolPolicy,
} from "@koi/core";
import { DEFAULT_HISTORY_DEFAULT, DEFAULT_HISTORY_LIMIT } from "../constants.js";
import { parseOptionalEnum, parseOptionalNumber } from "../parse-args.js";

export function createHistoryTool(
  component: SchedulerComponent,
  prefix: string,
  policy: ToolPolicy,
  historyLimit: number = DEFAULT_HISTORY_LIMIT,
  historyDefault: number = DEFAULT_HISTORY_DEFAULT,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_history`,
      description: `Query task execution history (completed/failed runs). Results clamped to max ${historyLimit}.`,
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["completed", "failed"],
            description: "Filter by run outcome",
          },
          since: {
            type: "number",
            description: "Only include runs started after this Unix timestamp (ms)",
          },
          limit: {
            type: "number",
            description: `Max results to return (default: ${historyDefault}, max: ${historyLimit})`,
          },
        },
        required: [],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const statusResult = parseOptionalEnum(args, "status", ["completed", "failed"] as const);
      if (!statusResult.ok) return statusResult.err;

      const sinceResult = parseOptionalNumber(args, "since");
      if (!sinceResult.ok) return sinceResult.err;

      const limitResult = parseOptionalNumber(args, "limit");
      if (!limitResult.ok) return limitResult.err;

      const requestedLimit = limitResult.value ?? historyDefault;
      const clampedLimit = Math.min(Math.max(1, requestedLimit), historyLimit);

      const filter: TaskHistoryFilter = {
        ...(statusResult.value !== undefined && { status: statusResult.value }),
        ...(sinceResult.value !== undefined && { since: sinceResult.value }),
        limit: clampedLimit,
      };

      try {
        const runs = await component.history(filter);
        return { runs, count: runs.length };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
