import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GatewayScheduler } from "../scheduler.js";
import { createScheduler } from "../scheduler.js";
import type { GatewayFrame, SchedulerDef, Session } from "../types.js";

describe("GatewayScheduler", () => {
  const dispatched: Array<{ session: Session; frame: GatewayFrame }> = [];
  let scheduler: GatewayScheduler | undefined;

  function dispatcher(session: Session, frame: GatewayFrame): void {
    dispatched.push({ session, frame });
  }

  beforeEach(() => {
    dispatched.length = 0;
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = undefined;
  });

  test("dispatches at configured interval", async () => {
    const defs: readonly SchedulerDef[] = [
      { id: "heartbeat", intervalMs: 100, agentId: "monitor-agent" },
    ];

    scheduler = createScheduler(defs, dispatcher);
    scheduler.start();

    // Wait for at least 2 ticks
    await new Promise((r) => setTimeout(r, 250));

    expect(dispatched.length).toBeGreaterThanOrEqual(2);
    for (const { session, frame } of dispatched) {
      expect(session.agentId).toBe("monitor-agent");
      expect(session.metadata).toEqual({ schedulerId: "heartbeat" });
      expect(frame.kind).toBe("event");
    }
  });

  test("custom payload included in frame", async () => {
    const customPayload = { type: "cleanup", target: "stale-sessions" };
    const defs: readonly SchedulerDef[] = [
      { id: "cleanup", intervalMs: 100, agentId: "janitor", payload: customPayload },
    ];

    scheduler = createScheduler(defs, dispatcher);
    scheduler.start();

    await new Promise((r) => setTimeout(r, 150));

    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    expect(dispatched[0]?.frame.payload).toEqual(customPayload);
  });

  test("default payload includes schedulerId and type:tick", async () => {
    const defs: readonly SchedulerDef[] = [{ id: "tick-test", intervalMs: 100, agentId: "ticker" }];

    scheduler = createScheduler(defs, dispatcher);
    scheduler.start();

    await new Promise((r) => setTimeout(r, 150));

    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    expect(dispatched[0]?.frame.payload).toEqual({
      schedulerId: "tick-test",
      type: "tick",
    });
  });

  test("multiple schedulers run independently", async () => {
    const defs: readonly SchedulerDef[] = [
      { id: "fast", intervalMs: 100, agentId: "fast-agent" },
      { id: "slow", intervalMs: 200, agentId: "slow-agent" },
    ];

    scheduler = createScheduler(defs, dispatcher);
    scheduler.start();

    await new Promise((r) => setTimeout(r, 450));

    const fastCount = dispatched.filter((d) => d.session.agentId === "fast-agent").length;
    const slowCount = dispatched.filter((d) => d.session.agentId === "slow-agent").length;

    // Fast should have more ticks than slow
    expect(fastCount).toBeGreaterThanOrEqual(3);
    expect(slowCount).toBeGreaterThanOrEqual(1);
    expect(fastCount).toBeGreaterThan(slowCount);
  });

  test("stop clears all timers", async () => {
    const defs: readonly SchedulerDef[] = [
      { id: "s1", intervalMs: 100, agentId: "a1" },
      { id: "s2", intervalMs: 100, agentId: "a2" },
    ];

    scheduler = createScheduler(defs, dispatcher);
    scheduler.start();

    await new Promise((r) => setTimeout(r, 150));
    const countBefore = dispatched.length;

    scheduler.stop();

    await new Promise((r) => setTimeout(r, 200));
    const countAfter = dispatched.length;

    // No new dispatches after stop
    expect(countAfter).toBe(countBefore);
  });

  test("count returns active timer count", () => {
    const defs: readonly SchedulerDef[] = [
      { id: "s1", intervalMs: 100, agentId: "a1" },
      { id: "s2", intervalMs: 100, agentId: "a2" },
      { id: "s3", intervalMs: 100, agentId: "a3" },
    ];

    scheduler = createScheduler(defs, dispatcher);
    expect(scheduler.count()).toBe(0);

    scheduler.start();
    expect(scheduler.count()).toBe(3);

    scheduler.stop();
    expect(scheduler.count()).toBe(0);
  });

  test("session id includes scheduler id", async () => {
    const defs: readonly SchedulerDef[] = [{ id: "my-sched", intervalMs: 100, agentId: "agent" }];

    scheduler = createScheduler(defs, dispatcher);
    scheduler.start();

    await new Promise((r) => setTimeout(r, 150));

    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    expect(dispatched[0]?.session.id).toBe("scheduler-my-sched");
  });

  test("each frame has unique id", async () => {
    const defs: readonly SchedulerDef[] = [{ id: "uniq", intervalMs: 100, agentId: "agent" }];

    scheduler = createScheduler(defs, dispatcher);
    scheduler.start();

    await new Promise((r) => setTimeout(r, 350));

    const ids = dispatched.map((d) => d.frame.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test("double start() does not create duplicate timers", async () => {
    const defs: readonly SchedulerDef[] = [{ id: "double", intervalMs: 100, agentId: "agent" }];

    scheduler = createScheduler(defs, dispatcher);
    scheduler.start();
    scheduler.start(); // second start should clear and recreate

    expect(scheduler.count()).toBe(1);

    await new Promise((r) => setTimeout(r, 250));

    // Should have ~2 ticks, NOT ~4 (which would happen if both sets ran)
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    expect(dispatched.length).toBeLessThanOrEqual(3);
  });

  test("connectedAt is stable across ticks", async () => {
    const defs: readonly SchedulerDef[] = [{ id: "stable", intervalMs: 100, agentId: "agent" }];

    scheduler = createScheduler(defs, dispatcher);
    scheduler.start();

    await new Promise((r) => setTimeout(r, 350));

    expect(dispatched.length).toBeGreaterThanOrEqual(2);
    const firstConnectedAt = dispatched[0]?.session.connectedAt;
    for (const { session } of dispatched) {
      expect(session.connectedAt).toBe(firstConnectedAt);
    }
  });

  test("throws when intervalMs is below minimum", () => {
    const defs: readonly SchedulerDef[] = [{ id: "too-fast", intervalMs: 10, agentId: "agent" }];

    expect(() => createScheduler(defs, dispatcher)).toThrow(/below minimum/);
  });
});
