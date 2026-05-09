/**
 * Monitor-facing tools — create/update/list/cancel monitor.
 *
 * Monitors are process-local metadata layered on top of recurring scheduler
 * entries. The scheduler owns delivery; this module owns the human-readable
 * monitor definition and same-process idempotency semantics for create.
 */

import type { JsonObject, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, scheduleId } from "@koi/core";
import { toJSONSchema, z } from "zod";
import type { ProactiveToolsConfig } from "./types.js";

const createMonitorSchema = z.object({
  name: z.string().min(1, "name is required").describe("Short monitor name shown in wake text."),
  goal: z
    .string()
    .min(1, "goal is required")
    .describe("What the monitor is trying to detect or decide."),
  check_prompt: z
    .string()
    .min(1, "check_prompt is required")
    .describe("Instructions the agent should follow when the monitor fires."),
  expression: z
    .string()
    .min(1, "expression is required")
    .describe('Cron expression understood by croner (e.g. "0 9 * * 1-5").'),
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
      "Best-effort same-process dedupe key for monitor creation. Re-using the same key " +
        "with identical monitor fields returns the original monitor_id and schedule_id; " +
        "mismatches fail closed.",
    ),
});

const updateMonitorSchema = z
  .object({
    monitor_id: z
      .string()
      .min(1, "monitor_id is required")
      .describe("Monitor identifier to update."),
    name: z.string().min(1).optional().describe("Replacement monitor name."),
    goal: z.string().min(1).optional().describe("Replacement monitor goal."),
    check_prompt: z.string().min(1).optional().describe("Replacement monitor instructions."),
    expression: z.string().min(1).optional().describe("Replacement cron expression."),
    context_hint: z.string().min(1).optional().describe("Replacement optional context hint."),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.goal !== undefined ||
      value.check_prompt !== undefined ||
      value.expression !== undefined ||
      value.context_hint !== undefined,
    "At least one updatable field must be provided",
  );

const cancelMonitorSchema = z.object({
  monitor_id: z.string().min(1, "monitor_id is required").describe("Monitor identifier to cancel."),
});

const listMonitorsSchema = z.object({});

interface MonitorCreateFingerprint {
  readonly name: string;
  readonly goal: string;
  readonly checkPrompt: string;
  readonly expression: string;
  readonly contextHint: string | undefined;
}

export interface MonitorRecord {
  readonly monitorId: string;
  readonly scheduleId: string;
  readonly name: string;
  readonly goal: string;
  readonly checkPrompt: string;
  readonly expression: string;
  readonly contextHint: string | undefined;
  readonly idempotencyKey: string | undefined;
}

type MonitorCreateEntry =
  | { readonly kind: "pending"; readonly promise: Promise<MonitorRecord> }
  | { readonly kind: "settled"; readonly record: MonitorRecord };

export interface MonitorToolState {
  readonly monitorsById: Map<string, MonitorRecord>;
  readonly idempotencyMap: Map<string, MonitorCreateEntry>;
  nextMonitorNumber: number;
}

export function createMonitorToolState(): MonitorToolState {
  return {
    monitorsById: new Map<string, MonitorRecord>(),
    idempotencyMap: new Map<string, MonitorCreateEntry>(),
    nextMonitorNumber: 1,
  };
}

export function formatMonitorWakeMessage(args: {
  readonly name: string;
  readonly goal: string;
  readonly checkPrompt: string;
  readonly contextHint?: string;
}): string {
  const lines = [`Monitor check: ${args.name}`, `Goal: ${args.goal}`, `Check: ${args.checkPrompt}`];
  if (args.contextHint !== undefined) {
    lines.push(`Context: ${args.contextHint}`);
  }
  return lines.join("\n");
}

function buildCreateFingerprint(args: {
  readonly name: string;
  readonly goal: string;
  readonly check_prompt: string;
  readonly expression: string;
  readonly context_hint?: string;
}): MonitorCreateFingerprint {
  return {
    name: args.name,
    goal: args.goal,
    checkPrompt: args.check_prompt,
    expression: args.expression,
    contextHint: args.context_hint,
  };
}

function monitorCreateMatches(
  record: MonitorRecord,
  fingerprint: MonitorCreateFingerprint,
): boolean {
  return (
    record.name === fingerprint.name &&
    record.goal === fingerprint.goal &&
    record.checkPrompt === fingerprint.checkPrompt &&
    record.expression === fingerprint.expression &&
    record.contextHint === fingerprint.contextHint
  );
}

function buildMonitorRecord(
  monitorId: string,
  scheduleIdValue: string,
  args: {
    readonly name: string;
    readonly goal: string;
    readonly checkPrompt: string;
    readonly expression: string;
    readonly contextHint?: string;
    readonly idempotencyKey?: string;
  },
): MonitorRecord {
  return {
    monitorId,
    scheduleId: scheduleIdValue,
    name: args.name,
    goal: args.goal,
    checkPrompt: args.checkPrompt,
    expression: args.expression,
    contextHint: args.contextHint,
    idempotencyKey: args.idempotencyKey,
  };
}

function createMonitorId(state: MonitorToolState): string {
  const id = `monitor-${state.nextMonitorNumber}`;
  state.nextMonitorNumber += 1;
  return id;
}

function listMonitorView(record: MonitorRecord): {
  readonly monitor_id: string;
  readonly schedule_id: string;
  readonly name: string;
  readonly goal: string;
  readonly check_prompt: string;
  readonly expression: string;
  readonly context_hint?: string;
} {
  return {
    monitor_id: record.monitorId,
    schedule_id: record.scheduleId,
    name: record.name,
    goal: record.goal,
    check_prompt: record.checkPrompt,
    expression: record.expression,
    context_hint: record.contextHint,
  };
}

export function createCreateMonitorTool(
  config: ProactiveToolsConfig,
  state: MonitorToolState,
): Tool {
  const { scheduler } = config;

  return {
    descriptor: {
      name: "create_monitor",
      description:
        "Register a recurring monitor that periodically re-dispatches this agent with a " +
        "structured monitor check prompt.",
      inputSchema: toJSONSchema(createMonitorSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = createMonitorSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }

      const { name, goal, check_prompt, expression, context_hint, idempotency_key } = parsed.data;
      const fingerprint = buildCreateFingerprint(parsed.data);

      if (idempotency_key !== undefined) {
        const existing = state.idempotencyMap.get(idempotency_key);
        if (existing !== undefined) {
          try {
            const record = existing.kind === "settled" ? existing.record : await existing.promise;
            if (!monitorCreateMatches(record, fingerprint)) {
              return {
                ok: false,
                error:
                  `idempotency_key '${idempotency_key}' already registered for a different monitor ` +
                  "(name, goal, check_prompt, expression, or context_hint differ). Use a " +
                  "distinct key, or cancel the existing monitor first.",
              };
            }
            return {
              ok: true,
              monitor_id: record.monitorId,
              schedule_id: record.scheduleId,
              deduped: true,
            };
          } catch (e: unknown) {
            return {
              ok: false,
              error: e instanceof Error ? e.message : "Failed to create monitor",
            };
          }
        }
      }

      const monitorId = createMonitorId(state);
      const wakeText = formatMonitorWakeMessage({
        name,
        goal,
        checkPrompt: check_prompt,
        contextHint: context_hint,
      });

      const submission = Promise.resolve()
        .then(() => scheduler.schedule(expression, { kind: "text", text: wakeText }, "dispatch"))
        .then((scheduledId): MonitorRecord => {
          const record = buildMonitorRecord(monitorId, String(scheduledId), {
            name,
            goal,
            checkPrompt: check_prompt,
            expression,
            contextHint: context_hint,
            idempotencyKey: idempotency_key,
          });
          state.monitorsById.set(record.monitorId, record);
          if (idempotency_key !== undefined) {
            state.idempotencyMap.set(idempotency_key, { kind: "settled", record });
          }
          return record;
        });

      const trackedSubmission = submission.catch((err: unknown): never => {
        if (idempotency_key !== undefined) {
          state.idempotencyMap.delete(idempotency_key);
        }
        throw err;
      });

      if (idempotency_key !== undefined) {
        state.idempotencyMap.set(idempotency_key, {
          kind: "pending",
          promise: trackedSubmission,
        });
      }

      try {
        const record = await trackedSubmission;
        return { ok: true, monitor_id: record.monitorId, schedule_id: record.scheduleId };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to create monitor",
        };
      }
    },
  };
}

export function createListMonitorsTool(state: MonitorToolState): Tool {
  return {
    descriptor: {
      name: "list_monitors",
      description: "List monitors registered in the current process.",
      inputSchema: toJSONSchema(listMonitorsSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = listMonitorsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }
      return {
        ok: true,
        monitors: [...state.monitorsById.values()].map((record) => listMonitorView(record)),
      };
    },
  };
}

export function createUpdateMonitorTool(
  config: ProactiveToolsConfig,
  state: MonitorToolState,
): Tool {
  const { scheduler } = config;

  return {
    descriptor: {
      name: "update_monitor",
      description:
        "Patch an existing monitor definition and rotate its backing recurring schedule.",
      inputSchema: toJSONSchema(updateMonitorSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = updateMonitorSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }

      const current = state.monitorsById.get(parsed.data.monitor_id);
      if (current === undefined) {
        return {
          ok: false,
          error: `monitor_id '${parsed.data.monitor_id}' not found`,
        };
      }

      const next = buildMonitorRecord(current.monitorId, current.scheduleId, {
        name: parsed.data.name ?? current.name,
        goal: parsed.data.goal ?? current.goal,
        checkPrompt: parsed.data.check_prompt ?? current.checkPrompt,
        expression: parsed.data.expression ?? current.expression,
        contextHint: parsed.data.context_hint ?? current.contextHint,
        idempotencyKey: current.idempotencyKey,
      });

      const wakeText = formatMonitorWakeMessage({
        name: next.name,
        goal: next.goal,
        checkPrompt: next.checkPrompt,
        contextHint: next.contextHint,
      });

      let newScheduleId: string;
      try {
        newScheduleId = String(
          await scheduler.schedule(next.expression, { kind: "text", text: wakeText }, "dispatch"),
        );
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to update monitor",
        };
      }

      const updated: MonitorRecord = {
        ...next,
        scheduleId: newScheduleId,
      };

      state.monitorsById.set(updated.monitorId, updated);
      if (updated.idempotencyKey !== undefined) {
        state.idempotencyMap.set(updated.idempotencyKey, { kind: "settled", record: updated });
      }

      try {
        await scheduler.unschedule(scheduleId(current.scheduleId));
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to retire previous monitor schedule",
        };
      }

      return {
        ok: true,
        monitor_id: updated.monitorId,
        schedule_id: updated.scheduleId,
      };
    },
  };
}

export function createCancelMonitorTool(
  config: ProactiveToolsConfig,
  state: MonitorToolState,
): Tool {
  const { scheduler } = config;

  return {
    descriptor: {
      name: "cancel_monitor",
      description: "Cancel an existing monitor by ID. Unknown monitor IDs return removed:false.",
      inputSchema: toJSONSchema(cancelMonitorSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = cancelMonitorSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }

      const record = state.monitorsById.get(parsed.data.monitor_id);
      if (record === undefined) {
        return { ok: true, removed: false };
      }

      try {
        await scheduler.unschedule(scheduleId(record.scheduleId));
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to cancel monitor",
        };
      }

      state.monitorsById.delete(record.monitorId);
      if (record.idempotencyKey !== undefined) {
        state.idempotencyMap.delete(record.idempotencyKey);
      }

      return { ok: true, removed: true };
    },
  };
}
