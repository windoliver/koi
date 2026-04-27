/**
 * `sleep` tool — schedules a delayed self-dispatch and returns wake metadata.
 *
 * In-memory idempotency: when the caller supplies `idempotency_key`, the tool
 * returns the same `task_id`/`wake_at_ms` on a retry with matching fields and
 * fails closed on collisions (same key, different `duration_ms` or
 * `wake_message`). Entries expire when the wake time has passed — the
 * scheduler has already delivered (or dropped) the task, so the same key may
 * legitimately register a fresh sleep afterwards.
 *
 * As with cron idempotency, this is in-memory only — durable cross-restart
 * dedup needs the underlying scheduler to honour idempotency keys at submit
 * time, which the current `@koi/scheduler` does not.
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
  idempotency_key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Stable caller-supplied key. Re-using the same key with the same duration and wake " +
        "message returns the original task_id (deduped:true). Mismatched fields fail closed " +
        "with an error rather than silently registering a duplicate wake-up.",
    ),
});

interface SleepRecord {
  readonly taskId: string;
  readonly wakeAtMs: number;
  readonly durationMs: number;
  readonly wakeMessage: string;
}

export interface SleepToolState {
  readonly idempotencyMap: Map<string, SleepRecord>;
}

export function createSleepToolState(): SleepToolState {
  return { idempotencyMap: new Map<string, SleepRecord>() };
}

function recordMatches(
  rec: SleepRecord,
  fingerprint: { readonly durationMs: number; readonly wakeMessage: string },
): boolean {
  return rec.durationMs === fingerprint.durationMs && rec.wakeMessage === fingerprint.wakeMessage;
}

export function createSleepTool(config: ProactiveToolsConfig, state: SleepToolState): Tool {
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

      const { duration_ms, wake_message, idempotency_key } = parsed.data;
      if (duration_ms > maxSleepMs) {
        return {
          ok: false,
          error: `duration_ms ${duration_ms} exceeds maxSleepMs ${maxSleepMs}`,
        };
      }

      const message = wake_message ?? defaultMessage;
      const submittedAt = now();

      if (idempotency_key !== undefined) {
        const existing = state.idempotencyMap.get(idempotency_key);
        if (existing !== undefined && existing.wakeAtMs > submittedAt) {
          if (!recordMatches(existing, { durationMs: duration_ms, wakeMessage: message })) {
            return {
              ok: false,
              error:
                `idempotency_key '${idempotency_key}' already registered for a different sleep ` +
                "(duration_ms or wake_message differs). Use a distinct key, or cancel the " +
                "pending task first.",
            };
          }
          return {
            ok: true,
            task_id: existing.taskId,
            wake_at_ms: existing.wakeAtMs,
            deduped: true,
          };
        }
        // Existing entry has expired — remove it so the new submission below
        // creates a fresh task and the map stays bounded.
        if (existing !== undefined) state.idempotencyMap.delete(idempotency_key);
      }

      const wakeAt = submittedAt + duration_ms;

      try {
        const taskIdValue = await scheduler.submit({ kind: "text", text: message }, "dispatch", {
          delayMs: duration_ms,
        });
        const idStr = String(taskIdValue);
        if (idempotency_key !== undefined) {
          state.idempotencyMap.set(idempotency_key, {
            taskId: idStr,
            wakeAtMs: wakeAt,
            durationMs: duration_ms,
            wakeMessage: message,
          });
        }
        return { ok: true, task_id: idStr, wake_at_ms: wakeAt };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to submit sleep task",
        };
      }
    },
  };
}
