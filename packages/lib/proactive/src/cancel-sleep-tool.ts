/**
 * `cancel_sleep` tool — withdraws a pending delayed dispatch by task id.
 *
 * Pairs with `sleep`: lets a later turn invalidate a wake-up that has been
 * superseded (e.g. the work the agent was waiting on completed early), or
 * retire an idempotency key after the timer has naturally fired. The
 * scheduler's `removed` flag is forwarded as-is — `false` may mean either
 * "already fired / never existed" or "remote cancel failed" depending on
 * the scheduler implementation.
 *
 * Local idempotency cleanup model
 * --------------------------------
 * On a confirmed `removed: true`, we drop any matching local idempotency
 * entry — the underlying task is gone, the key is safe to reuse.
 * On `removed: false`, we **leave** the entry in place by default: the
 * scheduler may not have actually removed the task, and silently freeing
 * the key would let a retry register a duplicate wake-up.
 *
 * Callers that have independent confirmation that the underlying task is
 * already complete (e.g. they observed the wake fire) may pass
 * `release_key: true` to force the local entry's removal regardless of
 * the scheduler's `removed` flag.
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
  release_key: z
    .boolean()
    .optional()
    .describe(
      "When true, also drop any local idempotency entry pointing at this task " +
        "even if the scheduler returns `removed: false`. Use only when you have " +
        "independent confirmation that the underlying task is complete or absent " +
        "(e.g. you observed the wake fire). Default false: a `removed: false` " +
        "result preserves the entry to avoid duplicate wake-ups on retry.",
    ),
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
      const releaseKey = parsed.data.release_key === true;
      try {
        const removed = await scheduler.cancel(taskId(idStr));
        // Clear local idempotency state ONLY when the scheduler confirmed
        // removal, OR when the caller explicitly opted in via release_key.
        // A bare `removed: false` may mean the cancel failed remotely; in
        // that case keeping the entry prevents a retry from registering a
        // duplicate wake-up.
        if (removed || releaseKey) {
          for (const [k, v] of state.idempotencyMap) {
            // Only settled entries have a known taskId. A pending entry can't
            // match this taskId because we only learn the id after submit
            // resolves — at which point it transitions to settled.
            if (v.kind === "settled" && v.record.taskId === idStr) {
              state.idempotencyMap.delete(k);
            }
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
