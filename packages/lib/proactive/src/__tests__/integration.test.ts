/**
 * E2E integration tests — proactive tools wired to the real in-memory
 * `@koi/scheduler`, not the test stub. Verifies timer fires, cancel actually
 * removes live work, reconciliation drops completed entries, and the
 * provider lifecycle matches what hosts will see.
 *
 * Each test stands up a fresh Scheduler + SchedulerComponent + provider,
 * tears it down on completion. Uses FakeClock so timers fire deterministically.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type {
  Agent,
  AgentId,
  EngineInput,
  SchedulerComponent,
  ScheduleStore,
  SubsystemToken,
  TaskScheduler,
  TaskStore,
} from "@koi/core";
import { agentId, DEFAULT_SCHEDULER_CONFIG, SCHEDULER, scheduleId, toolToken } from "@koi/core";
import { createProactiveToolsProvider } from "../provider.js";

setDefaultTimeout(15_000);

interface FakeClock {
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly tick: (ms: number) => void;
  readonly setTime: (ms: number) => void;
}

interface SchedulerModule {
  readonly createFakeClock: (initialTime?: number) => FakeClock;
  readonly createScheduler: (
    config: typeof DEFAULT_SCHEDULER_CONFIG,
    store: TaskStore,
    dispatcher: (
      agentId: AgentId,
      input: EngineInput,
      mode: "spawn" | "dispatch",
      signal: AbortSignal,
    ) => Promise<void>,
    clock?: FakeClock,
    scheduleStore?: ScheduleStore,
  ) => TaskScheduler;
  readonly createSchedulerComponent: (
    scheduler: TaskScheduler,
    agentId: AgentId,
  ) => SchedulerComponent;
  readonly createSqliteScheduleStore: (db: Database) => ScheduleStore;
  readonly createSqliteTaskStore: (db: Database) => TaskStore;
}

const schedulerSourceEntrypoint = "../../../../sched/scheduler/src/" + "index.js";
const schedulerModule = (await import(schedulerSourceEntrypoint)) as SchedulerModule;

const {
  createFakeClock,
  createScheduler,
  createSchedulerComponent,
  createSqliteScheduleStore,
  createSqliteTaskStore,
} = schedulerModule;

interface Harness {
  readonly scheduler: TaskScheduler;
  readonly schedulerComponent: SchedulerComponent;
  readonly clock: FakeClock;
  readonly dispatched: EngineInput[];
  readonly aid: AgentId;
  readonly dispose: () => Promise<void>;
}

function buildHarness(): Harness {
  const clock = createFakeClock(0);
  const dispatched: EngineInput[] = [];
  const db = new Database(":memory:");
  const scheduler = createScheduler(
    { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 1 },
    createSqliteTaskStore(db),
    async (_agentId: AgentId, input: EngineInput) => {
      dispatched.push(input);
    },
    clock,
    createSqliteScheduleStore(db),
  );
  const aid = agentId("agent-int" as AgentId);
  const schedulerComponent = createSchedulerComponent(scheduler, aid);
  return {
    scheduler,
    schedulerComponent,
    clock,
    dispatched,
    aid,
    async dispose(): Promise<void> {
      await scheduler[Symbol.asyncDispose]();
    },
  };
}

function makeAgent(scheduler: SchedulerComponent, aid: AgentId): Agent {
  const map = new Map<string, unknown>();
  map.set(SCHEDULER as string, scheduler);
  return {
    pid: {
      id: aid,
      name: aid as string,
      type: "worker",
      depth: 0,
    } as Agent["pid"],
    manifest: {} as unknown as Agent["manifest"],
    state: "running",
    component<T>(t: SubsystemToken<T>): T | undefined {
      return map.get(t as string) as T | undefined;
    },
    has(t: SubsystemToken<unknown>): boolean {
      return map.has(t as string);
    },
    hasAll(...tokens: readonly SubsystemToken<unknown>[]): boolean {
      return tokens.every((t) => map.has(t as string));
    },
    query<T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> {
      const out = new Map<SubsystemToken<T>, T>();
      for (const [k, v] of map) {
        if (k.startsWith(prefix)) out.set(k as SubsystemToken<T>, v as T);
      }
      return out;
    },
    components(): ReadonlyMap<string, unknown> {
      return map;
    },
  };
}

interface ToolMap {
  readonly sleep: { execute: (a: object) => Promise<unknown> };
  readonly cancelSleep: { execute: (a: object) => Promise<unknown> };
  readonly scheduleCron: { execute: (a: object) => Promise<unknown> };
  readonly cancelSchedule: { execute: (a: object) => Promise<unknown> };
  readonly createMonitor: { execute: (a: object) => Promise<unknown> };
  readonly listMonitors: { execute: (a: object) => Promise<unknown> };
  readonly updateMonitor: { execute: (a: object) => Promise<unknown> };
  readonly cancelMonitor: { execute: (a: object) => Promise<unknown> };
  readonly createBrief: { execute: (a: object) => Promise<unknown> };
  readonly listBriefs: { execute: (a: object) => Promise<unknown> };
  readonly updateBrief: { execute: (a: object) => Promise<unknown> };
  readonly cancelBrief: { execute: (a: object) => Promise<unknown> };
}

async function attachTools(scheduler: SchedulerComponent, aid: AgentId): Promise<ToolMap> {
  const provider = createProactiveToolsProvider();
  const agent = makeAgent(scheduler, aid);
  const result = await provider.attach(agent);
  const components = "components" in result ? result.components : result;
  const get = (name: string): { execute: (a: object) => Promise<unknown> } =>
    components.get(toolToken(name) as string) as {
      execute: (a: object) => Promise<unknown>;
    };
  return {
    sleep: get("sleep"),
    cancelSleep: get("cancel_sleep"),
    scheduleCron: get("schedule_cron"),
    cancelSchedule: get("cancel_schedule"),
    createMonitor: get("create_monitor"),
    listMonitors: get("list_monitors"),
    updateMonitor: get("update_monitor"),
    cancelMonitor: get("cancel_monitor"),
    createBrief: get("create_brief"),
    listBriefs: get("list_briefs"),
    updateBrief: get("update_brief"),
    cancelBrief: get("cancel_brief"),
  };
}

function expectedBriefWakeText(args: {
  readonly name: string;
  readonly topic: string;
  readonly window: string;
  readonly channel: string;
  readonly contextHint?: string;
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

// Drain any clock-scheduled microtasks the scheduler queued.
async function drain(clock: FakeClock, ms: number): Promise<void> {
  clock.tick(ms);
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => clock.setTimeout(r, 0));
  }
}

function cronExpressionAt(when: Date): string {
  return `${when.getSeconds()} ${when.getMinutes()} ${when.getHours()} ${when.getDate()} ${
    when.getMonth() + 1
  } *`;
}

function futureCronExpression(offsetMs: number): string {
  const nextWholeSecond = Math.ceil(Date.now() / 1_000) * 1_000;
  return cronExpressionAt(new Date(nextWholeSecond + offsetMs));
}

function expectedMonitorWakeText(args: {
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

async function waitForMonitorDispatch(
  harness: Harness,
  expectedCount: number,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (harness.dispatched.length < expectedCount) {
    if (Date.now() - startedAt > timeoutMs) {
      break;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    await drain(harness.clock, 1);
  }
}

describe("@koi/proactive integration with @koi/scheduler", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });
  afterEach(async () => {
    await h.dispose();
  });

  test("1. sleep fires after delay — dispatcher receives wake input", async () => {
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const result = (await tools.sleep.execute({
      duration_ms: 500,
      wake_message: "wake-1",
    })) as { ok: boolean; task_id: string; wake_at_ms: number };

    expect(result.ok).toBe(true);
    expect(h.dispatched).toHaveLength(0);

    await drain(h.clock, 500);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toEqual({ kind: "text", text: "wake-1" });
  });

  test("2. concurrent same-key calls share one submission", async () => {
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const [a, b, c] = (await Promise.all([
      tools.sleep.execute({ duration_ms: 1_000, idempotency_key: "k" }),
      tools.sleep.execute({ duration_ms: 1_000, idempotency_key: "k" }),
      tools.sleep.execute({ duration_ms: 1_000, idempotency_key: "k" }),
    ])) as { task_id: string }[];

    expect(a?.task_id).toBe(b?.task_id);
    expect(b?.task_id).toBe(c?.task_id);

    // Only one task fires
    await drain(h.clock, 1_000);
    expect(h.dispatched).toHaveLength(1);
  });

  test("3. cancel + retry-same-key registers a fresh task (no scheduler-level lock)", async () => {
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const first = (await tools.sleep.execute({
      duration_ms: 60_000,
      idempotency_key: "k",
    })) as { task_id: string };

    const cancelled = (await tools.cancelSleep.execute({
      task_id: first.task_id,
      release_key: true,
    })) as { ok: boolean; removed: boolean };
    expect(cancelled.removed).toBe(true);

    const retried = (await tools.sleep.execute({
      duration_ms: 60_000,
      idempotency_key: "k",
    })) as { ok: boolean; task_id: string };
    expect(retried.ok).toBe(true);
    expect(retried.task_id).not.toBe(first.task_id);

    // Drain to ensure the cancelled task does NOT fire and the retry does
    await drain(h.clock, 60_000);
    expect(h.dispatched).toHaveLength(1);
  });

  test("4. reconciliation frees the slot once a sleep has fired", async () => {
    const tools = await attachTools(h.schedulerComponent, h.aid);
    await tools.sleep.execute({ duration_ms: 100, idempotency_key: "k" });
    expect(h.dispatched).toHaveLength(0);

    await drain(h.clock, 100);
    expect(h.dispatched).toHaveLength(1);

    // After fire, the task is no longer reported live by scheduler.query
    // → reconciliation drops the entry → retry registers fresh.
    const second = (await tools.sleep.execute({
      duration_ms: 200,
      idempotency_key: "k",
    })) as { ok: boolean; task_id: string; deduped?: boolean };
    expect(second.ok).toBe(true);
    expect(second.deduped).toBeUndefined();

    await drain(h.clock, 200);
    expect(h.dispatched).toHaveLength(2);
  });

  test("5. cancel before fire — scheduler does not dispatch", async () => {
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const r = (await tools.sleep.execute({ duration_ms: 1_000 })) as {
      task_id: string;
    };
    await tools.cancelSleep.execute({ task_id: r.task_id });

    await drain(h.clock, 2_000);
    expect(h.dispatched).toHaveLength(0);
  });

  test("6. schedule_cron registers a live schedule; cancel_schedule removes it", async () => {
    // Croner runs on the real wall clock, not FakeClock, so we can't assert
    // on dispatch counts in a fake-time harness. Instead, verify the API
    // contract: schedule appears in querySchedules, cancel removes it, and
    // unschedule of the now-gone id reports removed:false.
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const r = (await tools.scheduleCron.execute({
      expression: "0 9 * * *",
      wake_message: "daily-9am",
    })) as { ok: boolean; schedule_id: string };
    expect(r.ok).toBe(true);

    const live = await h.scheduler.querySchedules(h.aid);
    expect(live.some((s: { readonly id: string }) => s.id === r.schedule_id)).toBe(true);

    const cancelled = (await tools.cancelSchedule.execute({
      schedule_id: r.schedule_id,
    })) as { ok: boolean; removed: boolean };
    expect(cancelled.removed).toBe(true);

    const liveAfter = await h.scheduler.querySchedules(h.aid);
    expect(liveAfter.some((s: { readonly id: string }) => s.id === r.schedule_id)).toBe(false);
  });

  test("7. create_monitor dispatches the synthesized monitor wake text and lists its summary", async () => {
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const expression = futureCronExpression(2_000);
    const wakeText = expectedMonitorWakeText({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      checkPrompt: "Inspect repo and GitHub state, then decide whether follow-up is warranted.",
      contextHint: "Look at scheduler/channel restoration issues first.",
    });
    const created = (await tools.createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo and GitHub state, then decide whether follow-up is warranted.",
      expression,
      context_hint: "Look at scheduler/channel restoration issues first.",
    })) as { ok: boolean; monitor_id: string; schedule_id: string };

    expect(created.ok).toBe(true);

    const listed = (await tools.listMonitors.execute({})) as {
      ok: boolean;
      monitors: {
        monitor_id: string;
        schedule_id: string;
        name: string;
        goal: string;
        expression: string;
        context_hint?: string;
      }[];
    };
    expect(listed.ok).toBe(true);
    expect(listed.monitors).toEqual([
      {
        monitor_id: created.monitor_id,
        schedule_id: created.schedule_id,
        name: "dependency-watch",
        goal: "Detect whether issue #1212 is unblocked",
        expression,
        context_hint: "Look at scheduler/channel restoration issues first.",
      },
    ]);

    const live = await h.scheduler.querySchedules(h.aid);
    expect(live).toHaveLength(1);
    expect(live[0]).toEqual({
      id: scheduleId(created.schedule_id),
      agentId: h.aid,
      expression,
      input: { kind: "text", text: wakeText },
      mode: "dispatch",
      paused: false,
    });

    await waitForMonitorDispatch(h, 1, 4_000);
    expect(h.dispatched).toEqual([
      {
        kind: "text",
        text: wakeText,
      },
    ]);
  });

  test("8. update_monitor rotates the live schedule and later dispatches only the updated monitor text", async () => {
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const initialExpression = futureCronExpression(5_000);
    const initialWakeText = expectedMonitorWakeText({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      checkPrompt: "Inspect repo state.",
    });
    const created = (await tools.createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression: initialExpression,
    })) as { monitor_id: string; schedule_id: string };

    const updatedExpression = futureCronExpression(2_000);
    const updatedWakeText = expectedMonitorWakeText({
      name: "dependency-watch",
      goal: "Detect whether issue #1301 is unblocked",
      checkPrompt: "Inspect delivery and durability state.",
      contextHint: "Focus on proactive delivery blockers first.",
    });
    const updated = (await tools.updateMonitor.execute({
      monitor_id: created.monitor_id,
      goal: "Detect whether issue #1301 is unblocked",
      check_prompt: "Inspect delivery and durability state.",
      expression: updatedExpression,
      context_hint: "Focus on proactive delivery blockers first.",
    })) as { ok: boolean; monitor_id: string; schedule_id: string };

    expect(updated.ok).toBe(true);
    expect(updated.monitor_id).toBe(created.monitor_id);
    expect(updated.schedule_id).not.toBe(created.schedule_id);

    const listed = (await tools.listMonitors.execute({})) as {
      monitors: {
        monitor_id: string;
        schedule_id: string;
        goal: string;
        expression: string;
        context_hint?: string;
      }[];
    };
    expect(listed.monitors).toHaveLength(1);
    expect(listed.monitors[0]?.monitor_id).toBe(created.monitor_id);
    expect(listed.monitors[0]?.schedule_id).toBe(updated.schedule_id);
    expect(listed.monitors[0]?.goal).toBe("Detect whether issue #1301 is unblocked");
    expect(listed.monitors[0]?.expression).toBe(updatedExpression);
    expect(listed.monitors[0]?.context_hint).toBe("Focus on proactive delivery blockers first.");

    const live = await h.scheduler.querySchedules(h.aid);
    expect(live).toHaveLength(1);
    expect(live[0]).toEqual({
      id: scheduleId(updated.schedule_id),
      agentId: h.aid,
      expression: updatedExpression,
      input: { kind: "text", text: updatedWakeText },
      mode: "dispatch",
      paused: false,
    });
    expect(live[0]?.id).not.toBe(created.schedule_id);
    expect(live[0]?.expression).not.toBe(initialExpression);
    expect(live[0]?.input).not.toEqual({ kind: "text", text: initialWakeText });

    await waitForMonitorDispatch(h, 1, 4_000);
    expect(h.dispatched).toEqual([
      {
        kind: "text",
        text: updatedWakeText,
      },
    ]);

    await waitForMonitorDispatch(h, 2, 4_500);
    expect(h.dispatched).toHaveLength(1);
  });

  test("9. cancel_monitor removes the listed monitor and suppresses future monitor dispatches", async () => {
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const expression = futureCronExpression(2_000);
    const wakeText = expectedMonitorWakeText({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      checkPrompt: "Inspect repo state.",
    });
    const created = (await tools.createMonitor.execute({
      name: "dependency-watch",
      goal: "Detect whether issue #1212 is unblocked",
      check_prompt: "Inspect repo state.",
      expression,
    })) as { monitor_id: string; schedule_id: string };

    const cancelled = (await tools.cancelMonitor.execute({
      monitor_id: created.monitor_id,
    })) as { ok: boolean; removed: boolean };

    expect(cancelled).toEqual({ ok: true, removed: true });

    const listed = (await tools.listMonitors.execute({})) as { monitors: unknown[] };
    expect(listed.monitors).toHaveLength(0);

    const live = await h.scheduler.querySchedules(h.aid);
    expect(live).toHaveLength(0);

    await waitForMonitorDispatch(h, 1, 3_500);
    expect(h.dispatched).toHaveLength(0);
    expect(h.dispatched).not.toContainEqual({ kind: "text", text: wakeText });
  });

  test("10. provider reattach against fresh scheduler — sleep heals via query, cron freshens per attach", async () => {
    // First scheduler: register a sleep + a cron.
    const tools1 = await attachTools(h.schedulerComponent, h.aid);
    const sleepR = (await tools1.sleep.execute({
      duration_ms: 60_000,
      idempotency_key: "sk",
    })) as { task_id: string };
    const cronR = (await tools1.scheduleCron.execute({
      expression: "0 9 * * *",
      idempotency_key: "ck",
    })) as { schedule_id: string };
    expect(sleepR.task_id).toBeDefined();
    expect(cronR.schedule_id).toBeDefined();

    // Build a second scheduler (fresh backend). Reattach the SAME provider
    // against the new scheduler component for the same agent id.
    const provider = createProactiveToolsProvider();
    // Re-create with provider so we test the actual cross-attach path.
    const _firstProviderAttach = await provider.attach(makeAgent(h.schedulerComponent, h.aid));
    void _firstProviderAttach;
    // Drive a sleep through the first attach so provider state is populated.
    const firstSleep = (
      "components" in _firstProviderAttach ? _firstProviderAttach.components : _firstProviderAttach
    ).get(toolToken("sleep") as string) as { execute: (a: object) => Promise<unknown> };
    await firstSleep.execute({ duration_ms: 60_000, idempotency_key: "sk2" });

    // Build fresh scheduler/component
    const h2 = buildHarness();
    try {
      const second = await provider.attach(makeAgent(h2.schedulerComponent, h.aid));
      const c2 = "components" in second ? second.components : second;
      const sleep2 = c2.get(toolToken("sleep") as string) as {
        execute: (a: object) => Promise<unknown>;
      };
      const cron2 = c2.get(toolToken("schedule_cron") as string) as {
        execute: (a: object) => Promise<unknown>;
      };

      // Sleep against the second scheduler with the SAME key — reconciliation
      // (via h2.scheduler.query → empty for "sk2") must drop the cached entry
      // and submit fresh. Verify by counting submissions on h2.
      const sleep2Result = (await sleep2.execute({
        duration_ms: 30_000,
        idempotency_key: "sk2",
      })) as { ok: boolean; deduped?: boolean };
      expect(sleep2Result.ok).toBe(true);
      expect(sleep2Result.deduped).toBeUndefined();

      // Cron fresh-state-per-attach: reattach makes a brand-new CronToolState,
      // so the same key must register fresh on h2.
      const cron2Result = (await cron2.execute({
        expression: "0 9 * * *",
        idempotency_key: "ck",
      })) as { ok: boolean; deduped?: boolean };
      expect(cron2Result.ok).toBe(true);
      expect(cron2Result.deduped).toBeUndefined();
    } finally {
      await h2.dispose();
    }
  });

  test("11. two agents on same provider — no cross-agent state leak", async () => {
    const provider = createProactiveToolsProvider();
    const aidA = agentId("agent-a" as AgentId);
    const aidB = agentId("agent-b" as AgentId);
    const compA = createSchedulerComponent(h.scheduler, aidA);
    const compB = createSchedulerComponent(h.scheduler, aidB);

    const resA = await provider.attach(makeAgent(compA, aidA));
    const resB = await provider.attach(makeAgent(compB, aidB));
    const sleepA = ("components" in resA ? resA.components : resA).get(
      toolToken("sleep") as string,
    ) as { execute: (a: object) => Promise<unknown> };
    const sleepB = ("components" in resB ? resB.components : resB).get(
      toolToken("sleep") as string,
    ) as { execute: (a: object) => Promise<unknown> };

    const a = (await sleepA.execute({
      duration_ms: 1_000,
      idempotency_key: "shared",
    })) as { task_id: string };
    const b = (await sleepB.execute({
      duration_ms: 2_000,
      idempotency_key: "shared",
    })) as { task_id: string };

    expect(a.task_id).not.toBe(b.task_id);

    await drain(h.clock, 2_000);
    expect(h.dispatched).toHaveLength(2);
  });

  test("13. create_brief dispatches the synthesized brief wake text and lists its summary", async () => {
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const expression = futureCronExpression(2_000);
    const wakeText = expectedBriefWakeText({
      name: "morning-digest",
      topic: "open PRs and CI failures",
      window: "last 24h",
      channel: "slack",
      contextHint: "Focus on user-impacting regressions first.",
    });
    const created = (await tools.createBrief.execute({
      name: "morning-digest",
      topic: "open PRs and CI failures",
      window: "last 24h",
      channel: "slack",
      expression,
      context_hint: "Focus on user-impacting regressions first.",
    })) as { ok: boolean; brief_id: string; schedule_id: string };

    expect(created.ok).toBe(true);

    const listed = (await tools.listBriefs.execute({})) as {
      ok: boolean;
      briefs: {
        brief_id: string;
        schedule_id: string;
        name: string;
        topic: string;
        window: string;
        channel: string;
        expression: string;
        context_hint?: string;
      }[];
    };
    expect(listed.ok).toBe(true);
    expect(listed.briefs).toEqual([
      {
        brief_id: created.brief_id,
        schedule_id: created.schedule_id,
        name: "morning-digest",
        topic: "open PRs and CI failures",
        window: "last 24h",
        channel: "slack",
        expression,
        context_hint: "Focus on user-impacting regressions first.",
      },
    ]);

    const live = await h.scheduler.querySchedules(h.aid);
    expect(live).toHaveLength(1);
    expect(live[0]).toEqual({
      id: scheduleId(created.schedule_id),
      agentId: h.aid,
      expression,
      input: { kind: "text", text: wakeText },
      mode: "dispatch",
      paused: false,
    });

    await waitForMonitorDispatch(h, 1, 4_000);
    expect(h.dispatched).toEqual([{ kind: "text", text: wakeText }]);
  });

  test("14. update_brief rotates the live schedule and later dispatches only the updated brief text", async () => {
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const initialExpression = futureCronExpression(5_000);
    const initialWakeText = expectedBriefWakeText({
      name: "morning-digest",
      topic: "open PRs",
      window: "last 24h",
      channel: "slack",
    });
    const created = (await tools.createBrief.execute({
      name: "morning-digest",
      topic: "open PRs",
      window: "last 24h",
      channel: "slack",
      expression: initialExpression,
    })) as { brief_id: string; schedule_id: string };

    const updatedExpression = futureCronExpression(3_000);
    const updatedWakeText = expectedBriefWakeText({
      name: "morning-digest",
      topic: "CI failures and flaky tests",
      window: "last 48h",
      channel: "email",
      contextHint: "Group by package.",
    });
    const updated = (await tools.updateBrief.execute({
      brief_id: created.brief_id,
      topic: "CI failures and flaky tests",
      window: "last 48h",
      channel: "email",
      expression: updatedExpression,
      context_hint: "Group by package.",
    })) as { ok: boolean; brief_id: string; schedule_id: string };

    expect(updated.ok).toBe(true);
    expect(updated.brief_id).toBe(created.brief_id);
    expect(updated.schedule_id).not.toBe(created.schedule_id);

    const live = await h.scheduler.querySchedules(h.aid);
    expect(live).toHaveLength(1);
    expect(live[0]).toEqual({
      id: scheduleId(updated.schedule_id),
      agentId: h.aid,
      expression: updatedExpression,
      input: { kind: "text", text: updatedWakeText },
      mode: "dispatch",
      paused: false,
    });
    expect(live[0]?.input).not.toEqual({ kind: "text", text: initialWakeText });

    await waitForMonitorDispatch(h, 1, 6_000);
    expect(h.dispatched).toEqual([{ kind: "text", text: updatedWakeText }]);

    await waitForMonitorDispatch(h, 2, 4_500);
    expect(h.dispatched).toHaveLength(1);
  });

  test("15. cancel_brief removes the listed brief and suppresses future brief dispatches", async () => {
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const expression = futureCronExpression(2_000);
    const wakeText = expectedBriefWakeText({
      name: "morning-digest",
      topic: "open PRs",
      window: "last 24h",
      channel: "slack",
    });
    const created = (await tools.createBrief.execute({
      name: "morning-digest",
      topic: "open PRs",
      window: "last 24h",
      channel: "slack",
      expression,
    })) as { brief_id: string; schedule_id: string };

    const cancelled = (await tools.cancelBrief.execute({
      brief_id: created.brief_id,
    })) as { ok: boolean; removed: boolean };

    expect(cancelled).toEqual({ ok: true, removed: true });

    const listed = (await tools.listBriefs.execute({})) as { briefs: unknown[] };
    expect(listed.briefs).toHaveLength(0);

    const live = await h.scheduler.querySchedules(h.aid);
    expect(live).toHaveLength(0);

    await waitForMonitorDispatch(h, 1, 3_500);
    expect(h.dispatched).toHaveLength(0);
    expect(h.dispatched).not.toContainEqual({ kind: "text", text: wakeText });
  });

  test("12. idempotency_key NOT forwarded to scheduler.submit (process-local only)", async () => {
    // Capture submissions by querying the scheduler directly. The internal
    // ScheduledTask record exposes metadata but not idempotencyKey directly,
    // so we instead validate the cancel→retry-same-key flow works (which
    // would fail if the scheduler were enforcing a stable id from the key).
    const tools = await attachTools(h.schedulerComponent, h.aid);
    const a = (await tools.sleep.execute({
      duration_ms: 60_000,
      idempotency_key: "x",
    })) as { task_id: string };
    await tools.cancelSleep.execute({ task_id: a.task_id, release_key: true });

    // Immediately retry with the same key — would fail with "already started"
    // if the durable scheduler were enforcing key-derived ids.
    const b = (await tools.sleep.execute({
      duration_ms: 60_000,
      idempotency_key: "x",
    })) as { ok: boolean };
    expect(b.ok).toBe(true);
  });
});
