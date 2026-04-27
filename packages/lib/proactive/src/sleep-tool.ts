/**
 * `sleep` tool — schedules a delayed wake and returns wake metadata.
 *
 * Mode: `"spawn"`, not `"dispatch"`
 * ---------------------------------
 * The durable Temporal scheduler explicitly rejects `dispatch` + `delayMs`
 * because dispatch targets a *running* workflow (signal delivery) and cannot
 * defer. Spawn + delayMs is supported on both the in-memory `@koi/scheduler`
 * and Temporal: the scheduler creates a fresh agent run at the wake time.
 * Hosts that need same-process state continuity across the wake should
 * persist that state through the agent's normal channels (memory, scratchpad,
 * etc.) — sleep is a wake-up trigger, not a coroutine resume.
 *
 * Idempotency model
 * -----------------
 * When the caller supplies `idempotency_key`, the tool stores an entry keyed
 * by that string. The entry first lives as an *in-flight* `Promise` of the
 * eventual record so concurrent same-key callers all observe the same
 * submission rather than racing past the map check. After the scheduler call
 * resolves, the entry is replaced by the settled record.
 *
 * - Match (settled record + matching fingerprint) → return original task_id
 *   plus `deduped: true`. Scheduler is **not** called.
 * - Match (in-flight) → await the same submission and inherit its result.
 * - Mismatch (settled record + different fingerprint) → fail closed.
 * - No entry → submit and store the in-flight promise atomically before
 *   awaiting the scheduler.
 *
 * Entries persist until `cancel_sleep` clears them. We deliberately do **not**
 * expire on wall-clock time: a backlogged or paused scheduler can still fire
 * the original task after `wake_at_ms` has passed, so allowing a fresh
 * submission on the same key would risk duplicate wake-ups. If the agent
 * wants to re-use the key, it must cancel first.
 *
 * Durability gap: state is in-memory only. Cross-restart dedup needs the
 * underlying scheduler to honour idempotency keys at submit time, which
 * `@koi/scheduler` does not — tracked separately.
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
    // Forwarded as TaskOptions.idempotencyKey. The Temporal scheduler builds
    // a stable task ID from `${agentId}:${mode}:${key}` and rejects keys
    // containing ':'. Reject up front so we surface a clear error rather
    // than letting the scheduler throw a delimiter-collision message.
    .refine((s) => !s.includes(":"), "idempotency_key must not contain ':'")
    .optional()
    .describe(
      "Best-effort process-local dedupe key. Re-using the same key with the same duration " +
        "and wake_message inside the SAME running process returns the original task_id " +
        "(deduped:true); mismatched fields fail closed. NOT durable across process restart " +
        "or agent reassembly — after a restart, the same key on a retry will register a " +
        "second wake-up. Use only as a same-session retry guard, not as a cross-restart " +
        "correctness guarantee. Entry persists until cancel_sleep is called.",
    ),
});

interface SleepRecord {
  readonly taskId: string;
  readonly wakeAtMs: number;
  readonly durationMs: number;
  readonly wakeMessage: string;
}

/**
 * Map entry — either an in-flight submission (for atomic reservation against
 * concurrent same-key calls) or the settled record once the scheduler returns.
 */
type SleepEntry =
  | { readonly kind: "pending"; readonly promise: Promise<SleepRecord> }
  | { readonly kind: "settled"; readonly record: SleepRecord };

/**
 * Hard cap on the idempotency map. Without it, agents that use unique keys
 * for every sleep would grow this state without bound (a successful wake
 * has no completion callback that we can hook for cleanup — the wake spawns
 * a fresh agent run, not a tool callback). When the cap is reached we evict
 * in insertion order, which on a `Map` is the same as least-recently-set
 * since callers don't update entries in place. Practical throughput targets:
 * 1 sleep / minute for ~17 hours of continuous activity before eviction.
 */
const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 1024;

export interface SleepToolState {
  readonly idempotencyMap: Map<string, SleepEntry>;
  readonly maxEntries: number;
}

export function createSleepToolState(maxEntries?: number): SleepToolState {
  return {
    idempotencyMap: new Map<string, SleepEntry>(),
    maxEntries: maxEntries ?? DEFAULT_MAX_IDEMPOTENCY_ENTRIES,
  };
}

/**
 * Insert/update with FIFO eviction when the cap is reached. We delete first
 * if the key already exists so re-setting bumps it to the back (Map iteration
 * order is insertion order). Eviction targets the oldest entry — agents
 * trying to retry the very oldest key after a reattach + 1024+ unique sleeps
 * may legitimately produce a duplicate; that is the documented bound, not a
 * silent correctness failure.
 */
function setBounded(state: SleepToolState, key: string, value: SleepEntry): void {
  if (state.idempotencyMap.has(key)) {
    state.idempotencyMap.delete(key);
  } else if (state.idempotencyMap.size >= state.maxEntries) {
    const oldest = state.idempotencyMap.keys().next().value;
    if (oldest !== undefined) state.idempotencyMap.delete(oldest);
  }
  state.idempotencyMap.set(key, value);
}

function recordMatches(
  rec: SleepRecord,
  fingerprint: { readonly durationMs: number; readonly wakeMessage: string },
): boolean {
  return rec.durationMs === fingerprint.durationMs && rec.wakeMessage === fingerprint.wakeMessage;
}

function buildCollisionResult(key: string): { readonly ok: false; readonly error: string } {
  return {
    ok: false,
    error:
      `idempotency_key '${key}' already registered for a different sleep ` +
      "(duration_ms or wake_message differs). Use a distinct key, or cancel the " +
      "pending task first.",
  };
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
      const fingerprint = { durationMs: duration_ms, wakeMessage: message };

      // Path 1: caller did not opt in to idempotency. Submit unconditionally.
      if (idempotency_key === undefined) {
        const submittedAt = now();
        const wakeAt = submittedAt + duration_ms;
        try {
          const id = await scheduler.submit({ kind: "text", text: message }, "spawn", {
            delayMs: duration_ms,
          });
          return { ok: true, task_id: String(id), wake_at_ms: wakeAt };
        } catch (e: unknown) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : "Failed to submit sleep task",
          };
        }
      }

      // Forwarded to the scheduler so any implementation that honours
      // `TaskOptions.idempotencyKey` durably (cross-restart) can also dedupe
      // there. The current `@koi/scheduler` ignores the field; the in-memory
      // map below remains the same-process safety net regardless.
      const submitOptions = {
        delayMs: duration_ms,
        idempotencyKey: idempotency_key,
      };

      // Path 2: idempotency_key supplied. Reserve atomically.
      const existing = state.idempotencyMap.get(idempotency_key);
      if (existing !== undefined) {
        try {
          const rec = existing.kind === "settled" ? existing.record : await existing.promise;
          if (!recordMatches(rec, fingerprint)) {
            return buildCollisionResult(idempotency_key);
          }
          return {
            ok: true,
            task_id: rec.taskId,
            wake_at_ms: rec.wakeAtMs,
            deduped: true,
          };
        } catch (e: unknown) {
          // The in-flight submission this key was tracking failed. Surface that
          // failure to this caller too — they should retry (which now finds an
          // empty slot since the rejected pending entry was deleted below).
          return {
            ok: false,
            error: e instanceof Error ? e.message : "Failed to submit sleep task",
          };
        }
      }

      const submittedAt = now();
      const wakeAt = submittedAt + duration_ms;
      // Reserve before awaiting. Concurrent same-key callers will see this
      // pending entry on their map.get and await the same promise.
      // SchedulerComponent.submit returns TaskId | Promise<TaskId> and may
      // throw synchronously. We invoke through Promise.resolve().then(...) so
      // both sync throws and async rejections become Promise rejections — and
      // the pattern is portable across older Node runtimes that lack
      // Promise.try (added in Node 22.10).
      const submission = Promise.resolve()
        .then(() => scheduler.submit({ kind: "text", text: message }, "spawn", submitOptions))
        .then((id): SleepRecord => {
          const rec: SleepRecord = {
            taskId: String(id),
            wakeAtMs: wakeAt,
            durationMs: duration_ms,
            wakeMessage: message,
          };
          setBounded(state, idempotency_key, { kind: "settled", record: rec });
          return rec;
        });
      // Catch the rejection so we can drop the failed reservation. We also
      // re-throw so the awaiting promise propagates to concurrent callers.
      const trackedSubmission = submission.catch((err: unknown): never => {
        state.idempotencyMap.delete(idempotency_key);
        throw err;
      });

      setBounded(state, idempotency_key, {
        kind: "pending",
        promise: trackedSubmission,
      });

      try {
        const rec = await trackedSubmission;
        return { ok: true, task_id: rec.taskId, wake_at_ms: rec.wakeAtMs };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to submit sleep task",
        };
      }
    },
  };
}
