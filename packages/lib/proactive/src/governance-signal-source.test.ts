import { describe, expect, test } from "bun:test";
import type { GovernanceController, SensorReading, SystemSignal } from "@koi/core";
import { createGovernanceSignalSource, type IntervalHandle } from "./governance-signal-source.js";

interface FakeClock {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
  // tick() flushes 2 microtask drains. Adequate because emit() schedules
  // exactly one microtask per subscriber per signal, and handlers under test
  // do not schedule further microtasks. If you add a test where the handler
  // itself schedules microtasks, increase the drain count.
  readonly tick: () => Promise<void>;
}

interface FakeTimer {
  readonly setInterval: (fn: () => void, ms: number) => number;
  readonly clearInterval: (id: IntervalHandle) => void;
  /** Fire all pending intervals once. */
  readonly fire: () => void;
  /** Number of currently-active intervals. */
  readonly activeCount: () => number;
}

function makeClock(start = 1_000_000): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    tick: async () => {
      // flush queued microtasks (handlers are deferred via queueMicrotask)
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function makeTimer(): FakeTimer {
  const intervals = new Map<number, () => void>();
  let nextId = 1;
  return {
    setInterval: (fn) => {
      const id = nextId++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id: IntervalHandle) => {
      intervals.delete(id as number);
    },
    fire: () => {
      for (const fn of intervals.values()) fn();
    },
    activeCount: () => intervals.size,
  };
}

function makeController(readings: Map<string, number>): GovernanceController {
  return {
    check: () => ({ ok: true }) as const,
    checkAll: () => ({ ok: true }) as const,
    record: () => undefined,
    snapshot: () => ({ timestamp: 0, readings: [], healthy: true, violations: [] }),
    variables: () => new Map(),
    reading: (name: string): SensorReading | undefined => {
      const v = readings.get(name);
      if (v === undefined) return undefined;
      return { name, current: v, limit: 0, utilization: 0 };
    },
  };
}

describe("createGovernanceSignalSource", () => {
  test("above-direction crossing emits one signal with correct shape", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([["error_rate", 0.1]]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const got: SystemSignal[] = [];
    source.watch((s) => got.push(s));

    // Below limit — no emit
    timer.fire();
    await clock.tick();
    expect(got).toHaveLength(0);

    // Cross above
    readings.set("error_rate", 0.4);
    timer.fire();
    await clock.tick();

    expect(got).toEqual([
      {
        kind: "governance",
        sensor: "error_rate",
        value: 0.4,
        limit: 0.3,
        direction: "above",
        emittedAt: 1_700_000_000_000,
      },
    ]);
  });

  test("value stays past threshold — no re-emit on subsequent polls", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([["error_rate", 0.4]]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const got: SystemSignal[] = [];
    source.watch((s) => got.push(s));

    // First poll: rising edge, emits.
    timer.fire();
    await clock.tick();
    expect(got).toHaveLength(1);

    // Subsequent polls while still above: no new emissions.
    clock.advance(5000);
    timer.fire();
    await clock.tick();
    clock.advance(5000);
    timer.fire();
    await clock.tick();
    expect(got).toHaveLength(1);
  });

  test("re-entry then re-crossing emits again after cooldown", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([["error_rate", 0.4]]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [{ sensor: "error_rate", limit: 0.3, direction: "above", cooldownMs: 1000 }],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const got: SystemSignal[] = [];
    source.watch((s) => got.push(s));

    // Cross 1
    timer.fire();
    await clock.tick();
    expect(got).toHaveLength(1);

    // Re-enter
    readings.set("error_rate", 0.1);
    clock.advance(2000);
    timer.fire();
    await clock.tick();
    expect(got).toHaveLength(1);

    // Cross 2 (after cooldown)
    readings.set("error_rate", 0.5);
    clock.advance(100);
    timer.fire();
    await clock.tick();
    expect(got).toHaveLength(2);
    expect(got[1]?.kind).toBe("governance");
  });

  test("re-entry then re-crossing within cooldown is suppressed", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([["error_rate", 0.4]]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [{ sensor: "error_rate", limit: 0.3, direction: "above", cooldownMs: 60_000 }],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const got: SystemSignal[] = [];
    source.watch((s) => got.push(s));

    timer.fire();
    await clock.tick();
    expect(got).toHaveLength(1);

    // Re-enter then cross again, well within cooldown
    readings.set("error_rate", 0.1);
    clock.advance(1000);
    timer.fire();
    await clock.tick();
    readings.set("error_rate", 0.5);
    clock.advance(1000);
    timer.fire();
    await clock.tick();

    expect(got).toHaveLength(1);
  });

  test("below-direction crossing emits", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([["spawn_count", 5]]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [{ sensor: "spawn_count", limit: 1, direction: "below" }],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const got: SystemSignal[] = [];
    source.watch((s) => got.push(s));

    // Above limit (not below): no emit
    timer.fire();
    await clock.tick();
    expect(got).toHaveLength(0);

    // Cross below
    readings.set("spawn_count", 0);
    timer.fire();
    await clock.tick();

    expect(got).toEqual([
      {
        kind: "governance",
        sensor: "spawn_count",
        value: 0,
        limit: 1,
        direction: "below",
        emittedAt: 1_700_000_000_000,
      },
    ]);
  });

  test("multiple sensors fire independently in same poll", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([
      ["error_rate", 0.4],
      ["spawn_count", 0],
    ]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [
        { sensor: "error_rate", limit: 0.3, direction: "above" },
        { sensor: "spawn_count", limit: 1, direction: "below" },
      ],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const got: SystemSignal[] = [];
    source.watch((s) => got.push(s));

    timer.fire();
    await clock.tick();

    expect(got).toHaveLength(2);
    const sensors = got.map((s) => (s.kind === "governance" ? s.sensor : null)).sort();
    expect(sensors).toEqual(["error_rate", "spawn_count"]);
  });

  test("multiple subscribers each receive emitted signals", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([["error_rate", 0.4]]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const a: SystemSignal[] = [];
    const b: SystemSignal[] = [];
    source.watch((s) => a.push(s));
    source.watch((s) => b.push(s));

    timer.fire();
    await clock.tick();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test("first watch starts the interval; second watch does not double-start", () => {
    const clock = makeClock();
    const timer = makeTimer();
    const source = createGovernanceSignalSource({
      controller: makeController(new Map()),
      thresholds: [],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    expect(timer.activeCount()).toBe(0);
    const off1 = source.watch(() => {});
    expect(timer.activeCount()).toBe(1);
    const off2 = source.watch(() => {});
    expect(timer.activeCount()).toBe(1);
    off1();
    expect(timer.activeCount()).toBe(1);
    off2();
    expect(timer.activeCount()).toBe(0);
  });

  test("last unsubscribe clears the interval and resets sensor state", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([["error_rate", 0.4]]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [{ sensor: "error_rate", limit: 0.3, direction: "above", cooldownMs: 60_000 }],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });

    const firstBatch: SystemSignal[] = [];
    const off = source.watch((s) => firstBatch.push(s));
    timer.fire();
    await clock.tick();
    expect(firstBatch).toHaveLength(1);
    off();
    expect(timer.activeCount()).toBe(0);

    // Re-watch: state was reset, fresh edge detection.
    const secondBatch: SystemSignal[] = [];
    source.watch((s) => secondBatch.push(s));
    timer.fire();
    await clock.tick();
    // State reset means the value 0.4 is treated as a fresh crossing.
    expect(secondBatch).toHaveLength(1);
  });

  test("unknown sensor name notifies onError, no throw, no signal", async () => {
    const clock = makeClock();
    const timer = makeTimer();
    const source = createGovernanceSignalSource({
      controller: makeController(new Map()),
      thresholds: [{ sensor: "ghost", limit: 1, direction: "above" }],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const got: SystemSignal[] = [];
    const errors: unknown[] = [];
    source.watch((s) => got.push(s), { onError: (e) => errors.push(e) });

    timer.fire();
    await clock.tick();

    expect(got).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("ghost");
  });

  test("handler throw notifies onError, loop continues", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([["error_rate", 0.4]]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [{ sensor: "error_rate", limit: 0.3, direction: "above", cooldownMs: 0 }],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const errors: unknown[] = [];
    source.watch(
      () => {
        throw new Error("handler boom");
      },
      { onError: (e) => errors.push(e) },
    );

    timer.fire();
    await clock.tick();
    // Re-enter and re-cross to verify the loop survived
    readings.set("error_rate", 0.1);
    timer.fire();
    await clock.tick();
    readings.set("error_rate", 0.4);
    timer.fire();
    await clock.tick();

    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect((errors[0] as Error).message).toBe("handler boom");
  });

  test("controller.reading throw notifies onError, next poll continues", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    let throwOnce = true;
    const controller: GovernanceController = {
      check: () => ({ ok: true }) as const,
      checkAll: () => ({ ok: true }) as const,
      record: () => undefined,
      snapshot: () => ({ timestamp: 0, readings: [], healthy: true, violations: [] }),
      variables: () => new Map(),
      reading: (name: string): SensorReading | undefined => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("reading boom");
        }
        return { name, current: 0.5, limit: 0, utilization: 0 };
      },
    };
    const source = createGovernanceSignalSource({
      controller,
      thresholds: [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const got: SystemSignal[] = [];
    const errors: unknown[] = [];
    source.watch((s) => got.push(s), { onError: (e) => errors.push(e) });

    timer.fire();
    await clock.tick();
    expect(errors).toHaveLength(1);
    expect(got).toHaveLength(0);

    timer.fire();
    await clock.tick();
    expect(got).toHaveLength(1);
  });

  test("per-threshold cooldownMs overrides default", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([["error_rate", 0.4]]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [{ sensor: "error_rate", limit: 0.3, direction: "above", cooldownMs: 100 }],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const got: SystemSignal[] = [];
    source.watch((s) => got.push(s));

    timer.fire();
    await clock.tick();
    readings.set("error_rate", 0.1);
    clock.advance(50);
    timer.fire();
    await clock.tick();
    readings.set("error_rate", 0.5);
    clock.advance(60);
    timer.fire();
    await clock.tick();

    // Cooldown is 100 ms; 50+60 = 110 ms ≥ 100 → second emit allowed.
    expect(got).toHaveLength(2);
  });

  test('source name is "governance"', () => {
    const clock = makeClock();
    const timer = makeTimer();
    const source = createGovernanceSignalSource({
      controller: makeController(new Map()),
      thresholds: [],
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    expect(source.name).toBe("governance");
  });
});
