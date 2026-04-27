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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentId,
  EngineInput,
  SchedulerComponent,
  SubsystemToken,
  TaskScheduler,
} from "@koi/core";
import { agentId, DEFAULT_SCHEDULER_CONFIG, SCHEDULER, toolToken } from "@koi/core";
import {
  createFakeClock,
  createScheduler,
  createSchedulerComponent,
  createSqliteScheduleStore,
  createSqliteTaskStore,
  type FakeClock,
} from "@koi/scheduler";
import { createProactiveToolsProvider } from "../provider.js";

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
    async (_a, inp) => {
      dispatched.push(inp);
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
  };
}

// Drain any clock-scheduled microtasks the scheduler queued.
async function drain(clock: FakeClock, ms: number): Promise<void> {
  clock.tick(ms);
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => clock.setTimeout(r, 0));
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
    expect(live.some((s) => s.id === r.schedule_id)).toBe(true);

    const cancelled = (await tools.cancelSchedule.execute({
      schedule_id: r.schedule_id,
    })) as { ok: boolean; removed: boolean };
    expect(cancelled.removed).toBe(true);

    const liveAfter = await h.scheduler.querySchedules(h.aid);
    expect(liveAfter.some((s) => s.id === r.schedule_id)).toBe(false);
  });

  test("7. provider reattach against fresh scheduler — sleep heals via query, cron freshens per attach", async () => {
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

  test("8. two agents on same provider — no cross-agent state leak", async () => {
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

  test("9. idempotency_key NOT forwarded to scheduler.submit (process-local only)", async () => {
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
