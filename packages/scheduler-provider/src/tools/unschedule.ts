/**
 * Tool factory for `scheduler_unschedule` — remove a recurring schedule.
 */

import type { JsonObject, SchedulerComponent, Tool, TrustTier } from "@koi/core";
import { scheduleId } from "@koi/core";
import { parseString } from "../parse-args.js";

export function createUnscheduleTool(
  component: SchedulerComponent,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_unschedule`,
      description: "Remove a recurring cron schedule by its ID.",
      inputSchema: {
        type: "object",
        properties: {
          scheduleId: { type: "string", description: "The schedule ID to remove" },
        },
        required: ["scheduleId"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const idResult = parseString(args, "scheduleId");
      if (!idResult.ok) return idResult.err;

      try {
        const removed = await component.unschedule(scheduleId(idResult.value));
        return { removed };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
