# Monitor Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class scheduler-backed `monitor` CRUD surface to `@koi/proactive` with process-local state, deterministic text wake payloads, and matching unit/integration coverage.

**Architecture:** Implement a new `monitor-tools.ts` module in `packages/lib/proactive/src` that owns input schemas, deterministic wake-message synthesis, create/list/update/cancel behavior, and same-process create-time idempotency. Wire a shared `MonitorToolState` into both `createProactiveTools()` and `createProactiveToolsProvider()` so monitors behave like the existing proactive tools, while keeping storage attach-local and avoiding any L0 contract widening.

**Tech Stack:** TypeScript 6, Bun test runner, Zod JSON schema generation, `@koi/core` tool contracts, `@koi/scheduler` integration harness.

---

## File Structure

### New files

- `packages/lib/proactive/src/monitor-tools.ts`
  - Owns monitor schemas, `MonitorRecord` / `MonitorToolState`, wake-message formatting, and the four tool factories.
- `packages/lib/proactive/src/monitor-tools.test.ts`
  - Unit tests for CRUD semantics, idempotency, update rotation, and deterministic wake text.

### Modified files

- `packages/lib/proactive/src/create-proactive-tools.ts`
  - Instantiates `MonitorToolState` and appends the new tools to the default tool list.
- `packages/lib/proactive/src/create-proactive-tools.test.ts`
  - Verifies the default tool list includes the monitor tools in stable order.
- `packages/lib/proactive/src/provider.ts`
  - Creates a fresh per-attach `MonitorToolState` and wires the monitor tools into attached agents.
- `packages/lib/proactive/src/provider.test.ts`
  - Verifies attached agents receive the four monitor tools and that monitor state is not shared across attaches.
- `packages/lib/proactive/src/index.ts`
  - Re-exports monitor tool helpers and state types that are part of the package API.
- `packages/lib/proactive/src/__tests__/integration.test.ts`
  - Adds end-to-end coverage against the real scheduler for create, update, and cancel behavior.
- `docs/L2/proactive.md`
  - Documents the monitor tool family, state limits, and restart behavior.

## Task 1: Add failing unit tests for monitor CRUD and wake formatting

**Files:**
- Create: `packages/lib/proactive/src/monitor-tools.test.ts`
- Reference: `packages/lib/proactive/src/test-helpers.ts`
- Reference: `packages/lib/proactive/src/cron-tools.test.ts`

- [ ] **Step 1: Write the failing unit tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  createCancelMonitorTool,
  createCreateMonitorTool,
  createListMonitorsTool,
  createMonitorToolState,
  createUpdateMonitorTool,
  formatMonitorWakeMessage,
} from "./monitor-tools.js";
import { createSchedulerStub } from "./test-helpers.js";

describe("monitor tools", () => {
  test("create_monitor stores a monitor and schedules a recurring wake", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo and GitHub state, then decide whether follow-up is warranted.",
      expression: "0 9 * * *",
      context_hint: "Look at scheduler/channel restoration issues first.",
      idempotency_key: "dep-watch",
    })) as { ok: boolean; monitor_id: string; schedule_id: string; deduped?: boolean };

    expect(created.ok).toBe(true);
    expect(created.deduped).toBeUndefined();
    expect(stub.scheduleCalls).toHaveLength(1);

    const listed = (await listMonitors.execute({})) as {
      ok: boolean;
      monitors: { monitor_id: string; name: string; goal: string; schedule_id: string }[];
    };
    expect(listed.monitors).toHaveLength(1);
    expect(listed.monitors[0]?.monitor_id).toBe(created.monitor_id);
    expect(listed.monitors[0]?.schedule_id).toBe(created.schedule_id);
  });

  test("create_monitor dedupes same-process identical idempotency_key", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);

    const args = {
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    };

    const first = (await createMonitor.execute(args)) as { monitor_id: string; schedule_id: string };
    const second = (await createMonitor.execute(args)) as {
      monitor_id: string;
      schedule_id: string;
      deduped?: boolean;
    };

    expect(second.monitor_id).toBe(first.monitor_id);
    expect(second.schedule_id).toBe(first.schedule_id);
    expect(second.deduped).toBe(true);
    expect(stub.scheduleCalls).toHaveLength(1);
  });

  test("create_monitor rejects a reused idempotency_key when monitor fields differ", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);

    await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    });

    const mismatch = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1301 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    })) as { ok: boolean; error: string };

    expect(mismatch.ok).toBe(false);
    expect(mismatch.error).toContain("already registered");
  });

  test("create_monitor validates required fields before touching the scheduler", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);

    const invalid = (await createMonitor.execute({
      name: "",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
    })) as { ok: boolean; error: string };

    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain("name");
    expect(stub.scheduleCalls).toHaveLength(0);
  });

  test("create_monitor clears its reservation after a failed scheduler create", async () => {
    const stub = createSchedulerStub({ scheduleError: new Error("scheduler unavailable") });
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);

    const failed = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    })) as { ok: boolean; error: string };
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("scheduler unavailable");

    const retry = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    })) as { ok: boolean; error: string };
    expect(retry.ok).toBe(false);
    expect(retry.error).toContain("scheduler unavailable");
    expect(state.monitorIdByIdempotencyKey.size).toBe(0);
  });

  test("update_monitor rotates the backing schedule and replaces stored fields", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);
    const updateMonitor = createUpdateMonitorTool({ scheduler: stub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
    })) as { monitor_id: string; schedule_id: string };

    const updated = (await updateMonitor.execute({
      monitor_id: created.monitor_id,
      goal: "Detect whether issue #1301 is unblocked",
      expression: "30 9 * * *",
      context_hint: "Focus on delivery and durability work.",
    })) as { ok: boolean; monitor_id: string; schedule_id: string };

    expect(updated.ok).toBe(true);
    expect(updated.schedule_id).not.toBe(created.schedule_id);
    expect(stub.unscheduleCalls).toEqual([created.schedule_id]);

    const listed = (await listMonitors.execute({})) as {
      monitors: { goal: string; expression: string; context_hint?: string; schedule_id: string }[];
    };
    expect(listed.monitors[0]?.goal).toBe("Detect whether issue #1301 is unblocked");
    expect(listed.monitors[0]?.expression).toBe("30 9 * * *");
    expect(listed.monitors[0]?.context_hint).toBe("Focus on delivery and durability work.");
    expect(listed.monitors[0]?.schedule_id).toBe(updated.schedule_id);
  });

  test("update_monitor fails for an unknown monitor_id", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const updateMonitor = createUpdateMonitorTool({ scheduler: stub.component }, state);

    const result = (await updateMonitor.execute({
      monitor_id: "monitor-missing",
      goal: "Detect whether issue #1301 is unblocked",
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
    expect(stub.scheduleCalls).toHaveLength(0);
    expect(stub.unscheduleCalls).toHaveLength(0);
  });

  test("update_monitor preserves omitted fields by patch semantics", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);
    const updateMonitor = createUpdateMonitorTool({ scheduler: stub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      context_hint: "Look at scheduler/channel restoration issues first.",
    })) as { monitor_id: string };

    await updateMonitor.execute({
      monitor_id: created.monitor_id,
      goal: "Detect whether issue #1301 is unblocked",
    });

    const listed = (await listMonitors.execute({})) as {
      monitors: { name: string; goal: string; expression: string; context_hint?: string }[];
    };
    expect(listed.monitors[0]?.name).toBe("dependency-watch");
    expect(listed.monitors[0]?.goal).toBe("Detect whether issue #1301 is unblocked");
    expect(listed.monitors[0]?.expression).toBe("0 9 * * *");
    expect(listed.monitors[0]?.context_hint).toBe(
      "Look at scheduler/channel restoration issues first.",
    );
  });

  test("update_monitor leaves the original record intact when replacement scheduling fails", async () => {
    const state = createMonitorToolState();
    const createStub = createSchedulerStub();
    const failingStub = createSchedulerStub({ scheduleError: new Error("scheduler unavailable") });
    const createMonitor = createCreateMonitorTool({ scheduler: createStub.component }, state);
    const updateMonitor = createUpdateMonitorTool({ scheduler: failingStub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
    })) as { monitor_id: string; schedule_id: string };

    const failed = (await updateMonitor.execute({
      monitor_id: created.monitor_id,
      goal: "Detect whether issue #1301 is unblocked",
    })) as { ok: boolean; error: string };
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("scheduler unavailable");

    const listed = (await listMonitors.execute({})) as {
      monitors: { goal: string; schedule_id: string }[];
    };
    expect(listed.monitors[0]?.goal).toBe("Detect whether issue #1212 is unblocked");
    expect(listed.monitors[0]?.schedule_id).toBe(created.schedule_id);
  });

  test("cancel_monitor removes the record and clears create-time idempotency", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const createMonitor = createCreateMonitorTool({ scheduler: stub.component }, state);
    const cancelMonitor = createCancelMonitorTool({ scheduler: stub.component }, state);
    const listMonitors = createListMonitorsTool(state);

    const created = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    })) as { monitor_id: string; schedule_id: string };

    const cancelled = (await cancelMonitor.execute({
      monitor_id: created.monitor_id,
    })) as { ok: boolean; removed: boolean };
    expect(cancelled).toEqual({ ok: true, removed: true });
    expect(stub.unscheduleCalls).toEqual([created.schedule_id]);

    const listed = (await listMonitors.execute({})) as { monitors: unknown[] };
    expect(listed.monitors).toHaveLength(0);

    const recreated = (await createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: "0 9 * * *",
      idempotency_key: "dep-watch",
    })) as { monitor_id: string };
    expect(recreated.monitor_id).not.toBe(created.monitor_id);
  });

  test("cancel_monitor returns removed:false for an unknown monitor_id", async () => {
    const stub = createSchedulerStub();
    const state = createMonitorToolState();
    const cancelMonitor = createCancelMonitorTool({ scheduler: stub.component }, state);

    const result = await cancelMonitor.execute({ monitor_id: "monitor-missing" });
    expect(result).toEqual({ ok: true, removed: false });
  });

  test("formatMonitorWakeMessage renders deterministic multi-line text", () => {
    expect(
      formatMonitorWakeMessage({
        name: "dependency-watch",
        goal: "Detect whether issue #1212 is unblocked",
        checkPrompt: "Inspect repo and GitHub state, then decide whether follow-up is warranted.",
        contextHint: "Look at scheduler/channel restoration issues first.",
      }),
    ).toBe(
      [
        "Monitor check: dependency-watch",
        "Goal: Detect whether issue #1212 is unblocked",
        "Check: Inspect repo and GitHub state, then decide whether follow-up is warranted.",
        "Context: Look at scheduler/channel restoration issues first.",
      ].join("\n"),
    );
  });

  test("formatMonitorWakeMessage omits the Context line when no context hint is present", () => {
    expect(
      formatMonitorWakeMessage({
        name: "dependency-watch",
        goal: "Detect whether issue #1212 is unblocked",
        checkPrompt: "Inspect repo state.",
      }),
    ).toBe(
      [
        "Monitor check: dependency-watch",
        "Goal: Detect whether issue #1212 is unblocked",
        "Check: Inspect repo state.",
      ].join("\n"),
    );
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `bun test packages/lib/proactive/src/monitor-tools.test.ts`

Expected: FAIL with module resolution errors for `./monitor-tools.js` exports that do not exist yet.

- [ ] **Step 3: Commit the red test**

```bash
git add packages/lib/proactive/src/monitor-tools.test.ts
git commit -m "test(proactive): define monitor tool behavior"
```

## Task 2: Implement `monitor-tools.ts`

**Files:**
- Create: `packages/lib/proactive/src/monitor-tools.ts`
- Reference: `packages/lib/proactive/src/cron-tools.ts`
- Reference: `packages/lib/proactive/src/types.ts`

- [ ] **Step 1: Write the monitor state, helpers, and schemas**

```ts
import type { JsonObject, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { toJSONSchema, z } from "zod";
import type { ProactiveToolsConfig } from "./types.js";

const createMonitorSchema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  check_prompt: z.string().min(1),
  expression: z.string().min(1),
  context_hint: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  idempotency_key: z.string().min(1).refine((s) => !s.includes(":"), "idempotency_key must not contain ':'").optional(),
});

const listMonitorsSchema = z.object({});

const updateMonitorSchema = z.object({
  monitor_id: z.string().min(1),
  name: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  check_prompt: z.string().min(1).optional(),
  expression: z.string().min(1).optional(),
  context_hint: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
});

const cancelMonitorSchema = z.object({
  monitor_id: z.string().min(1),
});

export interface MonitorRecord {
  readonly monitorId: string;
  readonly name: string;
  readonly goal: string;
  readonly checkPrompt: string;
  readonly expression: string;
  readonly timezone?: string;
  readonly contextHint?: string;
  readonly idempotencyKey?: string;
  readonly scheduleId: string;
}

export interface MonitorToolState {
  readonly monitorsById: Map<string, MonitorRecord>;
  readonly monitorIdByIdempotencyKey: Map<string, string>;
  nextMonitorOrdinal: number;
}

export function createMonitorToolState(): MonitorToolState {
  return {
    monitorsById: new Map<string, MonitorRecord>(),
    monitorIdByIdempotencyKey: new Map<string, string>(),
    nextMonitorOrdinal: 1,
  };
}

function nextMonitorId(state: MonitorToolState): string {
  const id = `monitor-${state.nextMonitorOrdinal}`;
  state.nextMonitorOrdinal += 1;
  return id;
}

export function formatMonitorWakeMessage(input: {
  readonly name: string;
  readonly goal: string;
  readonly checkPrompt: string;
  readonly contextHint?: string;
}): string {
  const lines = [
    `Monitor check: ${input.name}`,
    `Goal: ${input.goal}`,
    `Check: ${input.checkPrompt}`,
  ];
  if (input.contextHint !== undefined) lines.push(`Context: ${input.contextHint}`);
  return lines.join("\\n");
}
```

- [ ] **Step 2: Implement `create_monitor` and `list_monitors`**

```ts
export function createCreateMonitorTool(
  config: ProactiveToolsConfig,
  state: MonitorToolState,
): Tool {
  const { scheduler } = config;
  return {
    descriptor: {
      name: "create_monitor",
      description:
        "Create a recurring monitor that wakes this agent on a cron schedule with a monitoring brief.",
      inputSchema: toJSONSchema(createMonitorSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = createMonitorSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: parsed.error.message };
      const data = parsed.data;

      if (data.idempotency_key !== undefined) {
        const existingMonitorId = state.monitorIdByIdempotencyKey.get(data.idempotency_key);
        if (existingMonitorId !== undefined) {
          const existing = state.monitorsById.get(existingMonitorId);
          if (existing !== undefined) {
            const matches =
              existing.name === data.name &&
              existing.goal === data.goal &&
              existing.checkPrompt === data.check_prompt &&
              existing.expression === data.expression &&
              existing.timezone === data.timezone &&
              existing.contextHint === data.context_hint;
            if (!matches) {
              return {
                ok: false,
                error:
                  `idempotency_key '${data.idempotency_key}' already registered for a different monitor`,
              };
            }
            return {
              ok: true,
              monitor_id: existing.monitorId,
              schedule_id: existing.scheduleId,
              deduped: true,
            };
          }
        }
      }

      const monitorId = nextMonitorId(state);
      const wakeMessage = formatMonitorWakeMessage({
        name: data.name,
        goal: data.goal,
        checkPrompt: data.check_prompt,
        ...(data.context_hint !== undefined ? { contextHint: data.context_hint } : {}),
      });
      const scheduleOptions = data.timezone !== undefined ? { timezone: data.timezone } : undefined;

      try {
        const scheduleId = await scheduler.schedule(
          data.expression,
          { kind: "text", text: wakeMessage },
          "dispatch",
          scheduleOptions,
        );
        const record: MonitorRecord = {
          monitorId,
          name: data.name,
          goal: data.goal,
          checkPrompt: data.check_prompt,
          expression: data.expression,
          ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
          ...(data.context_hint !== undefined ? { contextHint: data.context_hint } : {}),
          ...(data.idempotency_key !== undefined ? { idempotencyKey: data.idempotency_key } : {}),
          scheduleId: String(scheduleId),
        };
        state.monitorsById.set(monitorId, record);
        if (data.idempotency_key !== undefined) {
          state.monitorIdByIdempotencyKey.set(data.idempotency_key, monitorId);
        }
        return { ok: true, monitor_id: monitorId, schedule_id: String(scheduleId) };
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed to create monitor" };
      }
    },
  };
}

export function createListMonitorsTool(state: MonitorToolState): Tool {
  return {
    descriptor: {
      name: "list_monitors",
      description: "List active monitor specs known to this running proactive tool state.",
      inputSchema: toJSONSchema(listMonitorsSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = listMonitorsSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: parsed.error.message };
      return {
        ok: true,
        monitors: [...state.monitorsById.values()].map((record) => ({
          monitor_id: record.monitorId,
          name: record.name,
          goal: record.goal,
          expression: record.expression,
          ...(record.contextHint !== undefined ? { context_hint: record.contextHint } : {}),
          schedule_id: record.scheduleId,
        })),
      };
    },
  };
}
```

- [ ] **Step 3: Implement `update_monitor` and `cancel_monitor`**

```ts
export function createUpdateMonitorTool(
  config: ProactiveToolsConfig,
  state: MonitorToolState,
): Tool {
  const { scheduler } = config;
  return {
    descriptor: {
      name: "update_monitor",
      description: "Update an existing monitor and replace its backing recurring schedule.",
      inputSchema: toJSONSchema(updateMonitorSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = updateMonitorSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: parsed.error.message };
      const existing = state.monitorsById.get(parsed.data.monitor_id);
      if (existing === undefined) {
        return { ok: false, error: `monitor_id '${parsed.data.monitor_id}' not found` };
      }

      const nextRecord: MonitorRecord = {
        ...existing,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.goal !== undefined ? { goal: parsed.data.goal } : {}),
        ...(parsed.data.check_prompt !== undefined ? { checkPrompt: parsed.data.check_prompt } : {}),
        ...(parsed.data.expression !== undefined ? { expression: parsed.data.expression } : {}),
        ...(parsed.data.timezone !== undefined ? { timezone: parsed.data.timezone } : {}),
        ...(parsed.data.context_hint !== undefined ? { contextHint: parsed.data.context_hint } : {}),
      };

      const wakeMessage = formatMonitorWakeMessage({
        name: nextRecord.name,
        goal: nextRecord.goal,
        checkPrompt: nextRecord.checkPrompt,
        ...(nextRecord.contextHint !== undefined ? { contextHint: nextRecord.contextHint } : {}),
      });

      try {
        const newScheduleId = await scheduler.schedule(
          nextRecord.expression,
          { kind: "text", text: wakeMessage },
          "dispatch",
          nextRecord.timezone !== undefined ? { timezone: nextRecord.timezone } : undefined,
        );
        await scheduler.unschedule(existing.scheduleId);
        const replaced: MonitorRecord = { ...nextRecord, scheduleId: String(newScheduleId) };
        state.monitorsById.set(existing.monitorId, replaced);
        return { ok: true, monitor_id: existing.monitorId, schedule_id: String(newScheduleId) };
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed to update monitor" };
      }
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
      description: "Cancel a recurring monitor and remove it from the current proactive tool state.",
      inputSchema: toJSONSchema(cancelMonitorSchema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = cancelMonitorSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: parsed.error.message };
      const existing = state.monitorsById.get(parsed.data.monitor_id);
      if (existing === undefined) return { ok: true, removed: false };
      try {
        const removed = await scheduler.unschedule(existing.scheduleId);
        state.monitorsById.delete(existing.monitorId);
        if (existing.idempotencyKey !== undefined) {
          state.monitorIdByIdempotencyKey.delete(existing.idempotencyKey);
        }
        return { ok: true, removed };
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed to cancel monitor" };
      }
    },
  };
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `bun test packages/lib/proactive/src/monitor-tools.test.ts`

Expected: PASS with all monitor CRUD and formatting tests green.

- [ ] **Step 5: Commit the implementation**

```bash
git add packages/lib/proactive/src/monitor-tools.ts packages/lib/proactive/src/monitor-tools.test.ts
git commit -m "feat(proactive): add monitor tools"
```

## Task 3: Wire monitor tools into the default proactive toolset and provider

**Files:**
- Modify: `packages/lib/proactive/src/create-proactive-tools.ts`
- Modify: `packages/lib/proactive/src/create-proactive-tools.test.ts`
- Modify: `packages/lib/proactive/src/provider.ts`
- Modify: `packages/lib/proactive/src/provider.test.ts`
- Modify: `packages/lib/proactive/src/index.ts`

- [ ] **Step 1: Extend `createProactiveTools()` and its test**

```ts
// packages/lib/proactive/src/create-proactive-tools.ts
import {
  createCancelMonitorTool,
  createCreateMonitorTool,
  createListMonitorsTool,
  createMonitorToolState,
  createUpdateMonitorTool,
} from "./monitor-tools.js";

export function createProactiveTools(config: ProactiveToolsConfig): readonly Tool[] {
  const cronState = createCronToolState();
  const sleepState = createSleepToolState();
  const monitorState = createMonitorToolState();
  return [
    createSleepTool(config, sleepState),
    createCancelSleepTool(config, sleepState),
    createScheduleCronTool(config, cronState),
    createCancelScheduleTool(config, cronState),
    createCreateMonitorTool(config, monitorState),
    createListMonitorsTool(monitorState),
    createUpdateMonitorTool(config, monitorState),
    createCancelMonitorTool(config, monitorState),
  ];
}
```

```ts
// packages/lib/proactive/src/create-proactive-tools.test.ts
expect(tools.map((t) => t.descriptor.name)).toEqual([
  "sleep",
  "cancel_sleep",
  "schedule_cron",
  "cancel_schedule",
  "create_monitor",
  "list_monitors",
  "update_monitor",
  "cancel_monitor",
]);
```

- [ ] **Step 2: Extend provider attach behavior**

```ts
// packages/lib/proactive/src/provider.ts
import {
  type MonitorToolState,
  createCancelMonitorTool,
  createCreateMonitorTool,
  createListMonitorsTool,
  createMonitorToolState,
  createUpdateMonitorTool,
} from "./monitor-tools.js";

function buildTools(
  toolConfig: ProactiveToolsConfig,
  sleepState: SleepToolState,
  cronState: CronToolState,
  monitorState: MonitorToolState,
): readonly Tool[] {
  return [
    createSleepTool(toolConfig, sleepState),
    createCancelSleepTool(toolConfig, sleepState),
    createScheduleCronTool(toolConfig, cronState),
    createCancelScheduleTool(toolConfig, cronState),
    createCreateMonitorTool(toolConfig, monitorState),
    createListMonitorsTool(monitorState),
    createUpdateMonitorTool(toolConfig, monitorState),
    createCancelMonitorTool(toolConfig, monitorState),
  ];
}

// inside attach()
const cronState = createCronToolState();
const monitorState = createMonitorToolState();
const tools = buildTools(toolConfig, sleepState, cronState, monitorState);
```

- [ ] **Step 3: Update provider tests for new tools and per-attach monitor isolation**

```ts
// packages/lib/proactive/src/provider.test.ts
const toolNames = [
  "sleep",
  "cancel_sleep",
  "schedule_cron",
  "cancel_schedule",
  "create_monitor",
  "list_monitors",
  "update_monitor",
  "cancel_monitor",
] as const;
```

```ts
test("monitor state resets on reattach — list_monitors reflects only the current attach", async () => {
  const stub = createSchedulerStub();
  const agent = makeAgent(stub.component, "agent-monitor");
  const provider = createProactiveToolsProvider();

  const first = await provider.attach(agent);
  const firstComps = "components" in first ? first.components : first;
  const createMonitor = firstComps.get(toolToken("create_monitor") as string) as {
    execute: (a: object) => Promise<unknown>;
  };
  const listMonitors = firstComps.get(toolToken("list_monitors") as string) as {
    execute: (a: object) => Promise<unknown>;
  };

  await createMonitor.execute({
    name: "dependency-watch",
    goal: "Detect whether issue #1212 is unblocked",
    check_prompt: "Inspect repo state.",
    expression: "0 9 * * *",
  });
  expect(((await listMonitors.execute({})) as { monitors: unknown[] }).monitors).toHaveLength(1);

  const second = await provider.attach(agent);
  const secondComps = "components" in second ? second.components : second;
  const listAfterReattach = secondComps.get(toolToken("list_monitors") as string) as {
    execute: (a: object) => Promise<unknown>;
  };

  expect(((await listAfterReattach.execute({})) as { monitors: unknown[] }).monitors).toHaveLength(0);
});
```

- [ ] **Step 4: Re-export monitor helpers**

```ts
// packages/lib/proactive/src/index.ts
export {
  createCancelMonitorTool,
  createCreateMonitorTool,
  createListMonitorsTool,
  createMonitorToolState,
  createUpdateMonitorTool,
  formatMonitorWakeMessage,
} from "./monitor-tools.js";
export type { MonitorRecord, MonitorToolState } from "./monitor-tools.js";
```

- [ ] **Step 5: Run focused tests and commit**

Run:

- `bun test packages/lib/proactive/src/create-proactive-tools.test.ts`
- `bun test packages/lib/proactive/src/provider.test.ts`

Expected: PASS with the expanded tool list and reattach behavior validated.

```bash
git add \
  packages/lib/proactive/src/create-proactive-tools.ts \
  packages/lib/proactive/src/create-proactive-tools.test.ts \
  packages/lib/proactive/src/provider.ts \
  packages/lib/proactive/src/provider.test.ts \
  packages/lib/proactive/src/index.ts
git commit -m "feat(proactive): wire monitor tools into provider"
```

## Task 4: Add scheduler-backed integration coverage

**Files:**
- Modify: `packages/lib/proactive/src/__tests__/integration.test.ts`

- [ ] **Step 1: Extend the harness tool map with monitor tools**

```ts
interface ToolMap {
  readonly sleep: { execute: (a: object) => Promise<unknown> };
  readonly cancelSleep: { execute: (a: object) => Promise<unknown> };
  readonly scheduleCron: { execute: (a: object) => Promise<unknown> };
  readonly cancelSchedule: { execute: (a: object) => Promise<unknown> };
  readonly createMonitor: { execute: (a: object) => Promise<unknown> };
  readonly listMonitors: { execute: (a: object) => Promise<unknown> };
  readonly updateMonitor: { execute: (a: object) => Promise<unknown> };
  readonly cancelMonitor: { execute: (a: object) => Promise<unknown> };
}

return {
  sleep: get("sleep"),
  cancelSleep: get("cancel_sleep"),
  scheduleCron: get("schedule_cron"),
  cancelSchedule: get("cancel_schedule"),
  createMonitor: get("create_monitor"),
  listMonitors: get("list_monitors"),
  updateMonitor: get("update_monitor"),
  cancelMonitor: get("cancel_monitor"),
};
```

- [ ] **Step 2: Add integration tests for create, update, and cancel**

```ts
test("monitor create schedules recurring wake text and lists the stored monitor", async () => {
  const tools = await attachTools(h.schedulerComponent, h.aid);
  const created = (await tools.createMonitor.execute({
    name: "dependency-watch",
    goal: "Detect whether issue #1212 is unblocked",
    check_prompt: "Inspect repo and GitHub state, then decide whether follow-up is warranted.",
    expression: "* * * * * *",
    context_hint: "Look at scheduler/channel restoration issues first.",
  })) as { ok: boolean; monitor_id: string; schedule_id: string };

  expect(created.ok).toBe(true);
  const listed = (await tools.listMonitors.execute({})) as {
    monitors: { monitor_id: string; schedule_id: string }[];
  };
  expect(listed.monitors[0]?.monitor_id).toBe(created.monitor_id);
  expect(listed.monitors[0]?.schedule_id).toBe(created.schedule_id);
});

test("monitor update rotates the schedule and future dispatches use the updated message", async () => {
  const tools = await attachTools(h.schedulerComponent, h.aid);
  const created = (await tools.createMonitor.execute({
    name: "dependency-watch",
    goal: "Detect whether issue #1212 is unblocked",
    check_prompt: "Inspect repo state.",
    expression: "* * * * * *",
  })) as { monitor_id: string; schedule_id: string };

  const updated = (await tools.updateMonitor.execute({
    monitor_id: created.monitor_id,
    goal: "Detect whether issue #1301 is unblocked",
    check_prompt: "Inspect delivery and durability state.",
    expression: "* * * * * *",
    context_hint: "Focus on proactive delivery blockers first.",
  })) as { ok: boolean; schedule_id: string };
  expect(updated.ok).toBe(true);
  expect(updated.schedule_id).not.toBe(created.schedule_id);

  const live = await h.scheduler.querySchedules(h.aid);
  expect(live.some((s) => s.id === updated.schedule_id)).toBe(true);
  expect(live.some((s) => s.id === created.schedule_id)).toBe(false);
});

test("cancel_monitor removes the stored monitor and unschedules future runs", async () => {
  const tools = await attachTools(h.schedulerComponent, h.aid);
  const created = (await tools.createMonitor.execute({
    name: "dependency-watch",
    goal: "Detect whether issue #1212 is unblocked",
    check_prompt: "Inspect repo state.",
    expression: "* * * * * *",
  })) as { monitor_id: string; schedule_id: string };

  const cancelled = (await tools.cancelMonitor.execute({
    monitor_id: created.monitor_id,
  })) as { ok: boolean; removed: boolean };
  expect(cancelled).toEqual({ ok: true, removed: true });

  const listed = (await tools.listMonitors.execute({})) as { monitors: unknown[] };
  expect(listed.monitors).toHaveLength(0);

  const live = await h.scheduler.querySchedules(h.aid);
  expect(live.some((s) => s.id === created.schedule_id)).toBe(false);
});
```

- [ ] **Step 3: Run the proactive integration suite**

Run: `bun test packages/lib/proactive/src/__tests__/integration.test.ts`

Expected: PASS with the new monitor cases green alongside the existing sleep/cron coverage.

- [ ] **Step 4: Commit the integration coverage**

```bash
git add packages/lib/proactive/src/__tests__/integration.test.ts
git commit -m "test(proactive): cover monitor scheduler integration"
```

## Task 5: Document the tool family and run package verification

**Files:**
- Modify: `docs/L2/proactive.md`

- [ ] **Step 1: Document the monitor tools and limits**

```md
## Monitor tools

The package also exposes a first-class recurring monitor surface:

- `create_monitor`
- `list_monitors`
- `update_monitor`
- `cancel_monitor`

These tools store monitor specs in process-local state and compile them into
recurring scheduler registrations. Each fire re-dispatches the same agent with
a deterministic plain-text monitoring brief.

### Scope and limits

- No durable monitor registry across restart or provider reattach
- `list_monitors` only reports monitors known to the current running tool state
- `idempotency_key` on `create_monitor` is same-process only
- No notification delivery or execution history in this slice
```

- [ ] **Step 2: Run package verification**

Run:

- `bun test packages/lib/proactive/src/monitor-tools.test.ts`
- `bun test packages/lib/proactive/src/create-proactive-tools.test.ts`
- `bun test packages/lib/proactive/src/provider.test.ts`
- `bun test packages/lib/proactive/src/__tests__/integration.test.ts`
- `bun --cwd packages/lib/proactive run typecheck`
- `bun --cwd packages/lib/proactive run lint`

Expected:

- all Bun test commands PASS
- `typecheck` exits 0
- `lint` exits 0

- [ ] **Step 3: Commit docs and verification-safe cleanup**

```bash
git add docs/L2/proactive.md
git commit -m "docs(proactive): document monitor tools"
```

## Self-Review

### Spec coverage

- First-class CRUD tool family: covered by Tasks 1-4.
- Process-local state and no durable reconciliation: covered by Task 2 state implementation and Task 3 reattach test.
- Deterministic plain-text wake payload: covered by Task 1 formatting test and Task 2 helper.
- Integration with default toolset/provider: covered by Task 3.
- Real scheduler integration: covered by Task 4.
- Public docs: covered by Task 5.

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” placeholders remain in the tasks.
- Every code-changing step includes concrete code or assertions.
- Every verification step includes exact commands.

### Type consistency

- Tool names are consistently `create_monitor`, `list_monitors`, `update_monitor`, `cancel_monitor`.
- Record fields consistently use `monitorId` internally and `monitor_id` in tool I/O.
- Wake formatting consistently uses `checkPrompt` internally and `check_prompt` in tool I/O.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-monitor-tool.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
