/**
 * Brief-facing tools — create/list/update/cancel recurring digest briefs.
 *
 * Briefs are process-local metadata layered on top of recurring scheduler
 * entries. The scheduler owns delivery; this module owns the human-readable
 * brief definition and same-process idempotency semantics for create. At
 * fire time the wake text instructs the agent to synthesize a digest of
 * `topic` over `window` and deliver via the `notify` tool to `channel`.
 */

import type { JsonObject, SchedulerComponent, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, scheduleId } from "@koi/core";
import { toJSONSchema, z } from "zod";
import type { ProactiveToolsConfig, ResolveChannel } from "./types.js";

const createBriefSchema = z.object({
  name: z.string().min(1, "name is required").describe("Short brief name shown in wake text."),
  topic: z
    .string()
    .min(1, "topic is required")
    .describe("What the agent should summarize (free-form)."),
  window: z
    .string()
    .min(1, "window is required")
    .describe('Time window for the digest (free-form, e.g. "last 7 days").'),
  channel: z
    .string()
    .min(1, "channel is required")
    .describe("Channel adapter name to deliver the digest via notify."),
  expression: z
    .string()
    .min(1, "expression is required")
    .describe('Cron expression understood by croner (e.g. "0 9 * * 1").'),
  timezone: z
    .string()
    .min(1)
    .optional()
    .describe('IANA timezone for the cron expression (e.g. "America/Los_Angeles").'),
  context_hint: z
    .string()
    .min(1)
    .optional()
    .describe("Optional extra context included in the wake text."),
  idempotency_key: z
    .string()
    .min(1)
    .refine((s) => !s.includes(":"), "idempotency_key must not contain ':'")
    .optional()
    .describe(
      "Best-effort same-process dedupe key for brief creation. Re-using the same key " +
        "with identical brief fields returns the original brief_id and schedule_id; " +
        "mismatches fail closed.",
    ),
});

const updateBriefSchema = z.object({
  brief_id: z.string().min(1, "brief_id is required").describe("Brief identifier to update."),
  name: z.string().min(1).optional().describe("Replacement brief name."),
  topic: z.string().min(1).optional().describe("Replacement brief topic."),
  window: z.string().min(1).optional().describe("Replacement digest window."),
  channel: z.string().min(1).optional().describe("Replacement delivery channel."),
  expression: z.string().min(1).optional().describe("Replacement cron expression."),
  timezone: z.string().min(1).optional().describe("Replacement cron timezone."),
  context_hint: z.string().min(1).optional().describe("Replacement optional context hint."),
});

const cancelBriefSchema = z.object({
  brief_id: z.string().min(1, "brief_id is required").describe("Brief identifier to cancel."),
});

const listBriefsSchema = z.object({});

interface BriefCreateFingerprint {
  readonly name: string;
  readonly topic: string;
  readonly window: string;
  readonly channel: string;
  readonly expression: string;
  readonly timezone: string | undefined;
  readonly contextHint: string | undefined;
}

export interface BriefRecord {
  readonly briefId: string;
  readonly scheduleId: string;
  readonly name: string;
  readonly topic: string;
  readonly window: string;
  readonly channel: string;
  readonly expression: string;
  readonly timezone: string | undefined;
  readonly contextHint: string | undefined;
  readonly idempotencyKey: string | undefined;
}

type BriefCreateEntry =
  | { readonly kind: "pending"; readonly promise: Promise<BriefRecord> }
  | { readonly kind: "settled"; readonly record: BriefRecord };

export interface BriefToolState {
  readonly briefsById: Map<string, BriefRecord>;
  readonly briefIdByIdempotencyKey: Map<string, string>;
  readonly createEntryByIdempotencyKey: Map<string, BriefCreateEntry>;
  nextBriefOrdinal: number;
}

export function createBriefToolState(): BriefToolState {
  return {
    briefsById: new Map<string, BriefRecord>(),
    briefIdByIdempotencyKey: new Map<string, string>(),
    createEntryByIdempotencyKey: new Map<string, BriefCreateEntry>(),
    nextBriefOrdinal: 1,
  };
}

export function formatBriefWakeMessage(args: {
  readonly name: string;
  readonly topic: string;
  readonly window: string;
  readonly channel: string;
  readonly contextHint?: string | undefined;
}): string {
  const lines = [
    `Brief: ${args.name}`,
    `Topic: ${args.topic}`,
    `Window: ${args.window}`,
    `Deliver to: ${args.channel}`,
  ];
  if (args.contextHint !== undefined) {
    lines.push(`Context: ${args.contextHint}`);
  }
  lines.push(
    "",
    "Synthesize a concise digest covering the topic over the window.",
    "Use the notify tool to deliver the digest to the channel above.",
  );
  return lines.join("\n");
}

function buildCreateFingerprint(args: {
  readonly name: string;
  readonly topic: string;
  readonly window: string;
  readonly channel: string;
  readonly expression: string;
  readonly timezone?: string | undefined;
  readonly context_hint?: string | undefined;
}): BriefCreateFingerprint {
  return {
    name: args.name,
    topic: args.topic,
    window: args.window,
    channel: args.channel,
    expression: args.expression,
    timezone: args.timezone,
    contextHint: args.context_hint,
  };
}

function briefCreateMatches(record: BriefRecord, fingerprint: BriefCreateFingerprint): boolean {
  return (
    record.name === fingerprint.name &&
    record.topic === fingerprint.topic &&
    record.window === fingerprint.window &&
    record.channel === fingerprint.channel &&
    record.expression === fingerprint.expression &&
    record.timezone === fingerprint.timezone &&
    record.contextHint === fingerprint.contextHint
  );
}

function buildBriefRecord(
  briefId: string,
  scheduleIdValue: string,
  args: {
    readonly name: string;
    readonly topic: string;
    readonly window: string;
    readonly channel: string;
    readonly expression: string;
    readonly timezone?: string | undefined;
    readonly contextHint?: string | undefined;
    readonly idempotencyKey?: string | undefined;
  },
): BriefRecord {
  return {
    briefId,
    scheduleId: scheduleIdValue,
    name: args.name,
    topic: args.topic,
    window: args.window,
    channel: args.channel,
    expression: args.expression,
    timezone: args.timezone,
    contextHint: args.contextHint,
    idempotencyKey: args.idempotencyKey,
  };
}

async function bestEffortUnscheduleReplacement(
  scheduler: SchedulerComponent,
  scheduleIdValue: string,
): Promise<void> {
  try {
    await scheduler.unschedule(scheduleId(scheduleIdValue));
  } catch {
    // Best-effort compensation only. Preserve the original local record either way.
  }
}

function createBriefId(state: BriefToolState): string {
  const id = `brief-${state.nextBriefOrdinal}`;
  state.nextBriefOrdinal += 1;
  return id;
}

function listBriefView(record: BriefRecord): {
  readonly brief_id: string;
  readonly schedule_id: string;
  readonly name: string;
  readonly topic: string;
  readonly window: string;
  readonly channel: string;
  readonly expression: string;
  readonly timezone?: string;
  readonly context_hint?: string;
} {
  const base = {
    brief_id: record.briefId,
    schedule_id: record.scheduleId,
    name: record.name,
    topic: record.topic,
    window: record.window,
    channel: record.channel,
    expression: record.expression,
  };
  const withTz = record.timezone !== undefined ? { ...base, timezone: record.timezone } : base;
  return record.contextHint !== undefined
    ? { ...withTz, context_hint: record.contextHint }
    : withTz;
}

function validateChannelOrReject(
  channel: string,
  resolveChannel: ResolveChannel | undefined,
  channelNames: (() => readonly string[]) | undefined,
): { ok: true } | { ok: false; error: string; available_channels: readonly string[] } {
  if (resolveChannel === undefined) {
    return { ok: true };
  }
  const adapter = resolveChannel(channel);
  if (adapter !== undefined) {
    return { ok: true };
  }
  const names = channelNames?.() ?? [];
  return {
    ok: false,
    error: `unknown channel: ${channel}`,
    available_channels: [...names].toSorted(),
  };
}

export function createCreateBriefTool(config: ProactiveToolsConfig, state: BriefToolState): Tool {
  const { scheduler, resolveChannel, channelNames } = config;

  return {
    descriptor: {
      name: "create_brief",
      description:
        "Register a recurring brief that periodically wakes this agent to synthesize " +
        "a digest of <topic> over <window> and deliver via notify to <channel>.",
      inputSchema: toJSONSchema(createBriefSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = createBriefSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }

      const { name, topic, window, channel, expression, timezone, context_hint, idempotency_key } =
        parsed.data;
      const fingerprint = buildCreateFingerprint(parsed.data);

      const channelCheck = validateChannelOrReject(channel, resolveChannel, channelNames);
      if (!channelCheck.ok) {
        return channelCheck;
      }

      if (idempotency_key !== undefined) {
        const existing = state.createEntryByIdempotencyKey.get(idempotency_key);
        if (existing !== undefined) {
          try {
            const record = existing.kind === "settled" ? existing.record : await existing.promise;
            if (!briefCreateMatches(record, fingerprint)) {
              return {
                ok: false,
                error:
                  `idempotency_key '${idempotency_key}' already registered for a different brief ` +
                  "(name, topic, window, channel, expression, timezone, or context_hint differ). Use a " +
                  "distinct key, or cancel the existing brief first.",
              };
            }
            return {
              ok: true,
              brief_id: record.briefId,
              schedule_id: record.scheduleId,
              deduped: true,
            };
          } catch (e: unknown) {
            return {
              ok: false,
              error: e instanceof Error ? e.message : "Failed to create brief",
            };
          }
        }
      }

      const briefId = createBriefId(state);
      const wakeText = formatBriefWakeMessage({
        name,
        topic,
        window,
        channel,
        contextHint: context_hint,
      });
      const scheduleOptions = timezone !== undefined ? { timezone } : undefined;

      const submission = Promise.resolve()
        .then(() =>
          scheduler.schedule(
            expression,
            { kind: "text", text: wakeText },
            "dispatch",
            scheduleOptions,
          ),
        )
        .then((scheduledId): BriefRecord => {
          const record = buildBriefRecord(briefId, String(scheduledId), {
            name,
            topic,
            window,
            channel,
            expression,
            timezone,
            contextHint: context_hint,
            idempotencyKey: idempotency_key,
          });
          state.briefsById.set(record.briefId, record);
          if (idempotency_key !== undefined) {
            state.briefIdByIdempotencyKey.set(idempotency_key, record.briefId);
            state.createEntryByIdempotencyKey.set(idempotency_key, { kind: "settled", record });
          }
          return record;
        });

      const trackedSubmission = submission.catch((err: unknown): never => {
        if (idempotency_key !== undefined) {
          state.createEntryByIdempotencyKey.delete(idempotency_key);
          state.briefIdByIdempotencyKey.delete(idempotency_key);
        }
        throw err;
      });

      if (idempotency_key !== undefined) {
        state.createEntryByIdempotencyKey.set(idempotency_key, {
          kind: "pending",
          promise: trackedSubmission,
        });
      }

      try {
        const record = await trackedSubmission;
        return { ok: true, brief_id: record.briefId, schedule_id: record.scheduleId };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to create brief",
        };
      }
    },
  };
}

export function createListBriefsTool(state: BriefToolState): Tool {
  return {
    descriptor: {
      name: "list_briefs",
      description: "List briefs registered in the current process.",
      inputSchema: toJSONSchema(listBriefsSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = listBriefsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }
      return {
        ok: true,
        briefs: [...state.briefsById.values()].map((record) => listBriefView(record)),
      };
    },
  };
}

export function createUpdateBriefTool(config: ProactiveToolsConfig, state: BriefToolState): Tool {
  const { scheduler, resolveChannel, channelNames } = config;

  return {
    descriptor: {
      name: "update_brief",
      description: "Patch an existing brief definition and rotate its backing recurring schedule.",
      inputSchema: toJSONSchema(updateBriefSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = updateBriefSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }

      const current = state.briefsById.get(parsed.data.brief_id);
      if (current === undefined) {
        return {
          ok: false,
          error: `brief_id '${parsed.data.brief_id}' not found`,
        };
      }

      const next = buildBriefRecord(current.briefId, current.scheduleId, {
        name: parsed.data.name ?? current.name,
        topic: parsed.data.topic ?? current.topic,
        window: parsed.data.window ?? current.window,
        channel: parsed.data.channel ?? current.channel,
        expression: parsed.data.expression ?? current.expression,
        timezone: parsed.data.timezone ?? current.timezone,
        contextHint: parsed.data.context_hint ?? current.contextHint,
        idempotencyKey: current.idempotencyKey,
      });

      if (parsed.data.channel !== undefined) {
        const channelCheck = validateChannelOrReject(next.channel, resolveChannel, channelNames);
        if (!channelCheck.ok) {
          return channelCheck;
        }
      }

      const wakeText = formatBriefWakeMessage({
        name: next.name,
        topic: next.topic,
        window: next.window,
        channel: next.channel,
        contextHint: next.contextHint,
      });
      const scheduleOptions = next.timezone !== undefined ? { timezone: next.timezone } : undefined;

      let newScheduleId: string;
      try {
        newScheduleId = String(
          await scheduler.schedule(
            next.expression,
            { kind: "text", text: wakeText },
            "dispatch",
            scheduleOptions,
          ),
        );
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to update brief",
        };
      }

      try {
        const removed = await scheduler.unschedule(scheduleId(current.scheduleId));
        if (!removed) {
          await bestEffortUnscheduleReplacement(scheduler, newScheduleId);
          return {
            ok: false,
            error: "Failed to retire previous brief schedule",
          };
        }
      } catch (e: unknown) {
        await bestEffortUnscheduleReplacement(scheduler, newScheduleId);
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to retire previous brief schedule",
        };
      }

      const updated: BriefRecord = {
        ...next,
        scheduleId: newScheduleId,
      };

      state.briefsById.set(updated.briefId, updated);
      if (updated.idempotencyKey !== undefined) {
        state.briefIdByIdempotencyKey.set(updated.idempotencyKey, updated.briefId);
        state.createEntryByIdempotencyKey.set(updated.idempotencyKey, {
          kind: "settled",
          record: updated,
        });
      }

      return {
        ok: true,
        brief_id: updated.briefId,
        schedule_id: updated.scheduleId,
      };
    },
  };
}

export function createCancelBriefTool(config: ProactiveToolsConfig, state: BriefToolState): Tool {
  const { scheduler } = config;

  return {
    descriptor: {
      name: "cancel_brief",
      description: "Cancel an existing brief by ID. Unknown brief IDs return removed:false.",
      inputSchema: toJSONSchema(cancelBriefSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = cancelBriefSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }

      const record = state.briefsById.get(parsed.data.brief_id);
      if (record === undefined) {
        return { ok: true, removed: false };
      }

      try {
        await scheduler.unschedule(scheduleId(record.scheduleId));
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to cancel brief",
        };
      }

      state.briefsById.delete(record.briefId);
      if (record.idempotencyKey !== undefined) {
        state.briefIdByIdempotencyKey.delete(record.idempotencyKey);
        state.createEntryByIdempotencyKey.delete(record.idempotencyKey);
      }

      return { ok: true, removed: true };
    },
  };
}
