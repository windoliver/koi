/**
 * Tool factory for `scheduler_resume` — resume a paused recurring schedule.
 */

import type { JsonObject, SchedulerComponent, Tool, TrustTier } from "@koi/core";
import { scheduleId } from "@koi/core";
import { parseString } from "../parse-args.js";

export function createResumeTool(
  component: SchedulerComponent,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_resume`,
      description: "Resume a paused cron schedule by its ID.",
      inputSchema: {
        type: "object",
        properties: {
          scheduleId: { type: "string", description: "The schedule ID to resume" },
        },
        required: ["scheduleId"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const idResult = parseString(args, "scheduleId");
      if (!idResult.ok) return idResult.err;

      try {
        const resumed = await component.resume(scheduleId(idResult.value));
        return { resumed };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
