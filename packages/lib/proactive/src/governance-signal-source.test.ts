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
});
