/**
 * Cron-facing tools — schedule_cron and cancel_schedule.
 *
 * Each tool is a thin wrapper over a single SchedulerComponent method. Errors
 * surface as `{ ok: false, error }` rather than throwing.
 *
 * Listing existing schedules is intentionally not exposed here: the L0
 * `SchedulerComponent` interface does not currently surface a per-agent
 * `querySchedules`. Adding one belongs in a focused L0 PR, not buried inside
 * a thin tool package. Until then, the host (e.g. `@koi/runtime`) is the
 * place to provide a listing surface if one is needed.
 */

import type { JsonObject, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, scheduleId } from "@koi/core";
import { toJSONSchema, z } from "zod";
import type { ProactiveToolsConfig } from "./types.js";
import { DEFAULT_WAKE_MESSAGE } from "./types.js";

// ---------------------------------------------------------------------------
// schedule_cron
// ---------------------------------------------------------------------------

const scheduleCronSchema = z.object({
  expression: z
    .string()
    .min(1)
    .describe('Cron expression understood by croner (e.g. "0 9 * * 1-5").'),
  wake_message: z.string().min(1).optional().describe("Text delivered to the agent on each fire."),
  timezone: z
    .string()
    .min(1)
    .optional()
    .describe('IANA timezone for the cron expression (e.g. "America/Los_Angeles").'),
});

export function createScheduleCronTool(config: ProactiveToolsConfig): Tool {
  const { scheduler } = config;
  const defaultMessage = config.defaultWakeMessage ?? DEFAULT_WAKE_MESSAGE;

  return {
    descriptor: {
      name: "schedule_cron",
      description:
        "Register a recurring cron schedule that re-dispatches this agent each fire. " +
        "Use for repeating maintenance, periodic checks, or daily summaries. The schedule " +
        "persists across runtime restarts when the host scheduler is durable.",
      inputSchema: toJSONSchema(scheduleCronSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = scheduleCronSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }
      const { expression, wake_message, timezone } = parsed.data;
      const message = wake_message ?? defaultMessage;
      try {
        const id = await scheduler.schedule(
          expression,
          { kind: "text", text: message },
          "dispatch",
          timezone !== undefined ? { timezone } : undefined,
        );
        return { ok: true, schedule_id: String(id) };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to register cron schedule",
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// cancel_schedule
// ---------------------------------------------------------------------------

const cancelScheduleSchema = z.object({
  schedule_id: z.string().min(1).describe("Schedule identifier returned by schedule_cron."),
});

export function createCancelScheduleTool(config: ProactiveToolsConfig): Tool {
  const { scheduler } = config;
  return {
    descriptor: {
      name: "cancel_schedule",
      description:
        "Remove a previously registered cron schedule by ID. Returns `{ removed: false }` " +
        "if the ID does not match an active schedule (idempotent — safe to retry).",
      inputSchema: toJSONSchema(cancelScheduleSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = cancelScheduleSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }
      try {
        const removed = await scheduler.unschedule(scheduleId(parsed.data.schedule_id));
        return { ok: true, removed };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to unschedule cron",
        };
      }
    },
  };
}
