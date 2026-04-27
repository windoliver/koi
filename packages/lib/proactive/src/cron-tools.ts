/**
 * Cron-facing tools — schedule_cron and cancel_schedule.
 *
 * Each tool is a thin wrapper over a single SchedulerComponent method. Errors
 * surface as `{ ok: false, error }` rather than throwing.
 *
 * Process-local idempotency
 * -------------------------
 * `idempotency_key` is a same-process retry guard. The provider keeps an
 * in-memory map keyed by the caller-supplied string, with each entry holding
 * a fingerprint (expression + wake_message + timezone) of the original
 * registration. A retry within the same process with matching fields returns
 * the original schedule_id (`deduped: true`); mismatches fail closed.
 *
 * It is NOT durable. After a process restart or agent reassembly the map is
 * empty, and a retry with the same key registers a second recurring schedule.
 * The caller-supplied key is forwarded as `TaskOptions.idempotencyKey` so any
 * future scheduler that honours it durably can dedupe at the boundary, but
 * the current `@koi/scheduler` ignores the field. Closing the cross-restart
 * gap is an L0/L2 contract change tracked separately.
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
    // Although schedule_cron does NOT forward this to the scheduler (Temporal
    // rejects schedule-level idempotency options), keep the same ':' refusal
    // rule as sleep so an agent that uses the same key shape across both
    // tools never picks something the durable submit() path would reject.
    .refine((s) => !s.includes(":"), "idempotency_key must not contain ':'")
    .optional()
    .describe(
      "Best-effort process-local dedupe key. Re-using the same key with the same expression, " +
        "wake_message, and timezone inside the SAME running process returns the existing " +
        "schedule_id (deduped:true); mismatched fields fail closed. NOT durable across " +
        "process restart or agent reassembly — after a restart, the same key on a retry will " +
        "register a second recurring schedule. Use only as a same-session retry guard. For " +
        "durable cross-restart correctness, the host runtime must additionally guarantee the " +
        "scheduler is not re-driven from the same caller after restart.",
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
 * Hard cap on the cron idempotency map. Recurring schedules typically don't
 * complete on their own, so this cap mainly protects against agents that
 * register a long tail of throwaway keys. The default is generous enough
 * for normal use; eviction is FIFO-order.
 */
const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 1024;

/**
 * Per-tool-instance state shared between schedule_cron and cancel_schedule.
 * Lets cancel_schedule clear an idempotency mapping once its schedule is gone.
 */
export interface CronToolState {
  /** idempotency_key → CronEntry */
  readonly idempotencyMap: Map<string, CronEntry>;
  readonly maxEntries: number;
}

export function createCronToolState(maxEntries?: number): CronToolState {
  return {
    idempotencyMap: new Map<string, CronEntry>(),
    maxEntries: maxEntries ?? DEFAULT_MAX_IDEMPOTENCY_ENTRIES,
  };
}

/**
 * Insert/update without evicting existing entries. Cron schedules stay live
 * until explicitly cancelled, so silently FIFO-evicting an old key while its
 * underlying schedule is still firing would let a retry with that key
 * register a duplicate recurring schedule. Instead, the caller must observe
 * the cap via {@link cronCapReached} and surface a clear error to the agent.
 */
function setCronEntry(state: CronToolState, key: string, value: CronEntry): void {
  state.idempotencyMap.set(key, value);
}

/**
 * Reports whether registering a fresh `key` would exceed the cap. Updates of
 * an already-tracked key are always allowed (the entry just transitions
 * pending → settled or settled → settled).
 */
function cronCapReached(state: CronToolState, key: string): boolean {
  if (state.idempotencyMap.has(key)) return false;
  return state.idempotencyMap.size >= state.maxEntries;
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

      // Do NOT forward idempotency_key into scheduler.schedule options.
      // The Temporal scheduler explicitly rejects every TaskOption on
      // schedule() (including idempotencyKey) because they cannot be persisted
      // or enforced by Temporal schedule policies — passing it through would
      // turn every retry-safe schedule_cron call into a hard failure under
      // the durable scheduler. Same-process dedup is enforced via the
      // in-memory map below; cross-restart cron dedup needs an L0/L2 contract
      // change that lets the scheduler accept a stable schedule ID.
      const scheduleOptions = timezone !== undefined ? { timezone } : undefined;

      // Path 2: idempotency_key supplied. Reserve atomically.
      // Cron entries cannot be evicted while live — a duplicate-firing
      // recurring schedule is a far worse failure mode than refusing to
      // register a new key. Surface the cap as an explicit error so the
      // agent can cancel an existing schedule before registering more.
      if (cronCapReached(state, idempotency_key)) {
        return {
          ok: false,
          error:
            `proactive cron idempotency cap reached (${state.maxEntries} active keys). ` +
            "Cancel an existing schedule via cancel_schedule before registering more, " +
            "or omit idempotency_key to bypass the dedupe map.",
        };
      }

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
          setCronEntry(state, idempotency_key, { kind: "settled", record: rec });
          return rec;
        });
      const trackedSubmission = submission.catch((err: unknown): never => {
        state.idempotencyMap.delete(idempotency_key);
        throw err;
      });

      setCronEntry(state, idempotency_key, {
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
  release_key: z
    .boolean()
    .optional()
    .describe(
      "When true, also drop any local idempotency entry pointing at this schedule " +
        "even if the scheduler returns `removed: false`. Use only when you have " +
        "independent confirmation that the schedule is gone. Default false: a " +
        "`removed: false` result preserves the entry to avoid duplicate registrations " +
        "on retry.",
    ),
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
      const releaseKey = parsed.data.release_key === true;
      try {
        const removed = await scheduler.unschedule(scheduleId(idStr));
        // Clear local idempotency state only when the scheduler confirmed
        // removal, OR when the caller explicitly opted in via release_key.
        // A bare `removed: false` may indicate the remote schedule still
        // exists; freeing the key would let a retry register a duplicate.
        if (removed || releaseKey) {
          for (const [k, v] of state.idempotencyMap) {
            // Only settled entries have a known scheduleId. A pending entry
            // can't match because we only learn the id after schedule resolves.
            if (v.kind === "settled" && v.record.scheduleId === idStr) {
              state.idempotencyMap.delete(k);
            }
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
