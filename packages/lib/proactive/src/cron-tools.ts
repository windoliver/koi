/**
 * Cron-facing tools — schedule_cron and cancel_schedule.
 *
 * Each tool is a thin wrapper over a single SchedulerComponent method. Errors
 * surface as `{ ok: false, error }` rather than throwing.
 *
 * In-memory idempotency: when the caller supplies `idempotency_key`, the
 * provider remembers `key → schedule_id` and returns the existing id on
 * re-submit. This makes retries inside one agent session safe (the common
 * failure mode after an ambiguous tool ACK). Durable cross-restart dedup
 * requires the underlying scheduler to honour idempotency keys at the
 * schedule layer — the current `@koi/scheduler` implementation does not, so
 * a restart followed by a retry can still create a duplicate. That gap is
 * an L0/L2 contract change tracked separately and deliberately not papered
 * over here.
 *
 * Listing existing schedules is intentionally not exposed here: the L0
 * `SchedulerComponent` interface does not currently surface a per-agent
 * `querySchedules`. Adding one belongs in a focused L0 PR, not buried inside
 * a thin tool package.
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
  idempotency_key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Stable caller-supplied key. Re-using the same key with the same expression is a no-op " +
        "(the existing schedule_id is returned), so retrying after an ambiguous failure cannot " +
        "create duplicate recurring schedules. Strongly recommended for any cron the agent " +
        "might re-issue.",
    ),
});

/**
 * Cached registration record. We keep enough fingerprint data to detect
 * idempotency-key collisions where the caller reuses a key for distinct work
 * (different expression, wake message, or timezone). Mismatches fail closed —
 * we never silently return a stale schedule_id.
 */
interface CronRecord {
  readonly scheduleId: string;
  readonly expression: string;
  readonly wakeMessage: string;
  readonly timezone: string | undefined;
}

/**
 * Map entry — either an in-flight registration (for atomic reservation against
 * concurrent same-key calls) or the settled record once the scheduler returns.
 */
type CronEntry =
  | { readonly kind: "pending"; readonly promise: Promise<CronRecord> }
  | { readonly kind: "settled"; readonly record: CronRecord };

/**
 * Per-tool-instance state shared between schedule_cron and cancel_schedule.
 * Lets cancel_schedule clear an idempotency mapping once its schedule is gone.
 */
export interface CronToolState {
  /** idempotency_key → CronEntry */
  readonly idempotencyMap: Map<string, CronEntry>;
}

export function createCronToolState(): CronToolState {
  return { idempotencyMap: new Map<string, CronEntry>() };
}

function recordsMatch(rec: CronRecord, other: Omit<CronRecord, "scheduleId">): boolean {
  return (
    rec.expression === other.expression &&
    rec.wakeMessage === other.wakeMessage &&
    rec.timezone === other.timezone
  );
}

export function createScheduleCronTool(config: ProactiveToolsConfig, state: CronToolState): Tool {
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
      const { expression, wake_message, timezone, idempotency_key } = parsed.data;
      const message = wake_message ?? defaultMessage;
      const fingerprint = { expression, wakeMessage: message, timezone };

      // Path 1: caller did not opt in to idempotency. Submit unconditionally.
      if (idempotency_key === undefined) {
        const noKeyOptions = timezone !== undefined ? { timezone } : undefined;
        try {
          const id = await scheduler.schedule(
            expression,
            { kind: "text", text: message },
            "dispatch",
            noKeyOptions,
          );
          return { ok: true, schedule_id: String(id) };
        } catch (e: unknown) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : "Failed to register cron schedule",
          };
        }
      }

      // Forward idempotency_key so any scheduler that honours
      // TaskOptions.idempotencyKey durably can dedupe there too. The current
      // `@koi/scheduler` ignores the field; the in-memory map below remains
      // the same-process safety net regardless.
      const scheduleOptions = {
        ...(timezone !== undefined ? { timezone } : {}),
        idempotencyKey: idempotency_key,
      };

      // Path 2: idempotency_key supplied. Reserve atomically.
      const existing = state.idempotencyMap.get(idempotency_key);
      if (existing !== undefined) {
        try {
          const rec = existing.kind === "settled" ? existing.record : await existing.promise;
          if (!recordsMatch(rec, fingerprint)) {
            return {
              ok: false,
              error:
                `idempotency_key '${idempotency_key}' already registered for a different cron ` +
                "(expression, wake_message, or timezone differ). Use a distinct key, or cancel " +
                "the existing schedule first.",
            };
          }
          return { ok: true, schedule_id: rec.scheduleId, deduped: true };
        } catch (e: unknown) {
          // The in-flight registration this key was tracking failed. The
          // pending entry has already been deleted (see catch handler below)
          // so a retry now finds an empty slot — surface the original error.
          return {
            ok: false,
            error: e instanceof Error ? e.message : "Failed to register cron schedule",
          };
        }
      }

      // Reserve before awaiting. Concurrent same-key callers will see this
      // pending entry on their map.get and await the same promise.
      // scheduler.schedule may throw synchronously on invalid expressions.
      // Use Promise.resolve().then(...) so both sync throws and async
      // rejections become Promise rejections — and the pattern is portable
      // across older Node runtimes that lack Promise.try (Node 22.10+).
      const submission = Promise.resolve()
        .then(() =>
          scheduler.schedule(
            expression,
            { kind: "text", text: message },
            "dispatch",
            scheduleOptions,
          ),
        )
        .then((id): CronRecord => {
          const rec: CronRecord = {
            scheduleId: String(id),
            expression,
            wakeMessage: message,
            timezone,
          };
          state.idempotencyMap.set(idempotency_key, { kind: "settled", record: rec });
          return rec;
        });
      const trackedSubmission = submission.catch((err: unknown): never => {
        state.idempotencyMap.delete(idempotency_key);
        throw err;
      });

      state.idempotencyMap.set(idempotency_key, {
        kind: "pending",
        promise: trackedSubmission,
      });

      try {
        const rec = await trackedSubmission;
        return { ok: true, schedule_id: rec.scheduleId };
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

export function createCancelScheduleTool(config: ProactiveToolsConfig, state: CronToolState): Tool {
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
      const idStr = parsed.data.schedule_id;
      try {
        const removed = await scheduler.unschedule(scheduleId(idStr));
        // Clear any matching idempotency entry regardless of `removed` so the
        // key is freed for re-use even when the schedule was already cleared
        // (e.g., scheduler restart, manual delete, or already unscheduled).
        for (const [k, v] of state.idempotencyMap) {
          // Only settled entries have a known scheduleId. A pending entry
          // can't match because we only learn the id after schedule resolves.
          if (v.kind === "settled" && v.record.scheduleId === idStr) {
            state.idempotencyMap.delete(k);
          }
        }
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
