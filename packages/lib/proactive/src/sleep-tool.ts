/**
 * `sleep` tool — schedules a delayed self-dispatch and returns wake metadata.
 *
 * The tool itself is stateless. All persistence lives in the injected
 * SchedulerComponent.
 */

import type { JsonObject, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { toJSONSchema, z } from "zod";
import type { ProactiveToolsConfig } from "./types.js";
import { DEFAULT_MAX_SLEEP_MS, DEFAULT_WAKE_MESSAGE } from "./types.js";

const schema = z.object({
  duration_ms: z
    .number()
    .int("duration_ms must be an integer")
    .min(1, "duration_ms must be at least 1 ms"),
  wake_message: z
    .string()
    .min(1)
    .optional()
    .describe("Text delivered to the agent when the timer fires."),
});

export function createSleepTool(config: ProactiveToolsConfig): Tool {
  const { scheduler } = config;
  const defaultMessage = config.defaultWakeMessage ?? DEFAULT_WAKE_MESSAGE;
  const maxSleepMs = config.maxSleepMs ?? DEFAULT_MAX_SLEEP_MS;
  const now = config.now ?? Date.now;

  return {
    descriptor: {
      name: "sleep",
      description:
        "Pause the agent and schedule a wake-up after `duration_ms` milliseconds. " +
        "Use when the right next step is to wait — e.g. polling for an external " +
        "result, honoring a rate limit, or deferring follow-up work. The agent " +
        "resumes with a fresh turn carrying `wake_message` (or a default).",
      inputSchema: toJSONSchema(schema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }

      const { duration_ms, wake_message } = parsed.data;
      if (duration_ms > maxSleepMs) {
        return {
          ok: false,
          error: `duration_ms ${duration_ms} exceeds maxSleepMs ${maxSleepMs}`,
        };
      }

      const wakeAt = now() + duration_ms;
      const message = wake_message ?? defaultMessage;

      try {
        const taskId = await scheduler.submit({ kind: "text", text: message }, "dispatch", {
          delayMs: duration_ms,
        });
        return { ok: true, task_id: String(taskId), wake_at_ms: wakeAt };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to submit sleep task",
        };
      }
    },
  };
}
