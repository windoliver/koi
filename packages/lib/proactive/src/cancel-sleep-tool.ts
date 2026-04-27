/**
 * `cancel_sleep` tool — withdraws a pending delayed dispatch by task id.
 *
 * Pairs with `sleep`: lets a later turn invalidate a wake-up that has been
 * superseded (e.g. the work the agent was waiting on completed early), or
 * retire an idempotency key after the timer has naturally fired. The
 * scheduler's `removed` flag is forwarded as-is — `false` means the task
 * already fired or never existed (idempotent, safe to retry).
 *
 * Local idempotency state is cleared whenever the caller invokes this tool
 * with a matching task_id, regardless of `removed`. Otherwise sleep entries
 * would leak after natural completion (the scheduler returns `false` for
 * already-fired tasks and there is no completion callback to clean up).
 */

import type { JsonObject, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskId } from "@koi/core";
import { toJSONSchema, z } from "zod";
import type { SleepToolState } from "./sleep-tool.js";
import type { ProactiveToolsConfig } from "./types.js";

const schema = z.object({
  task_id: z
    .string()
    .min(1)
    .describe("Task identifier returned by the `sleep` tool's `task_id` field."),
});

export function createCancelSleepTool(config: ProactiveToolsConfig, state: SleepToolState): Tool {
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
      const idStr = parsed.data.task_id;
      try {
        const removed = await scheduler.cancel(taskId(idStr));
        // Clear matching local idempotency state regardless of `removed` — an
        // already-fired task is exactly the case where the agent needs the
        // key freed for re-use and the scheduler returns `false`.
        for (const [k, v] of state.idempotencyMap) {
          // Only settled entries have a known taskId. A pending entry can't
          // match this taskId because we only learn the id after submit
          // resolves — at which point it transitions to settled.
          if (v.kind === "settled" && v.record.taskId === idStr) {
            state.idempotencyMap.delete(k);
          }
        }
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
