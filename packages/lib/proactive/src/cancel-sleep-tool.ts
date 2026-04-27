/**
 * `cancel_sleep` tool — withdraws a pending delayed dispatch by task id.
 *
 * Pairs with `sleep`: lets a later turn invalidate a wake-up that has been
 * superseded (e.g. the work the agent was waiting on completed early).
 * Returns `{ removed: false }` if the task already fired or never existed —
 * idempotent, safe to retry.
 */

import type { JsonObject, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskId } from "@koi/core";
import { toJSONSchema, z } from "zod";
import type { ProactiveToolsConfig } from "./types.js";

const schema = z.object({
  task_id: z
    .string()
    .min(1)
    .describe("Task identifier returned by the `sleep` tool's `task_id` field."),
});

export function createCancelSleepTool(config: ProactiveToolsConfig): Tool {
  const { scheduler } = config;
  return {
    descriptor: {
      name: "cancel_sleep",
      description:
        "Cancel a pending wake-up scheduled by `sleep` before it fires. Use when the work " +
        "the agent was waiting on completed early or has been superseded. Returns " +
        "`{ removed: false }` if the task has already fired or never existed (idempotent).",
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
      try {
        const removed = await scheduler.cancel(taskId(parsed.data.task_id));
        return { ok: true, removed };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to cancel sleep task",
        };
      }
    },
  };
}
