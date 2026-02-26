/**
 * Tool factory for `scheduler_pause` — pause a recurring schedule.
 */

import type { JsonObject, SchedulerComponent, Tool, TrustTier } from "@koi/core";
import { scheduleId } from "@koi/core";
import { parseString } from "../parse-args.js";

export function createPauseTool(
  component: SchedulerComponent,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_pause`,
      description:
        "Pause a recurring cron schedule by its ID. Paused schedules stop firing until resumed.",
      inputSchema: {
        type: "object",
        properties: {
          scheduleId: { type: "string", description: "The schedule ID to pause" },
        },
        required: ["scheduleId"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const idResult = parseString(args, "scheduleId");
      if (!idResult.ok) return idResult.err;

      try {
        const paused = await component.pause(scheduleId(idResult.value));
        return { paused };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
