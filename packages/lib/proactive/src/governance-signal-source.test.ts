import { describe, expect, test } from "bun:test";
import type { GovernanceController, SensorReading, SystemSignal } from "@koi/core";
import { createGovernanceSignalSource } from "./governance-signal-source.js";

interface FakeClock {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
  readonly tick: () => Promise<void>;
}

interface FakeTimer {
  readonly setInterval: (fn: () => void, ms: number) => number;
  readonly clearInterval: (id: number) => void;
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
    clearInterval: (id) => {
      intervals.delete(id);
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
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
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
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
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
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
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
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
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
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
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
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
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
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
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
});
