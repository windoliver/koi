/**
 * Tool factory for `scheduler_stats` — get scheduler statistics.
 */

import type { JsonObject, SchedulerComponent, Tool, TrustTier } from "@koi/core";

export function createStatsTool(
  component: SchedulerComponent,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_stats`,
      description: "Get current scheduler statistics (task counts by status).",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      } as JsonObject,
    },
    trustTier,
    execute: async (_args: JsonObject): Promise<unknown> => {
      try {
        return await component.stats();
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
