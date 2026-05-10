# Governance signal source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `createGovernanceSignalSource` to `@koi/proactive` that polls a `GovernanceController` and emits `SystemSignal{kind: "governance"}` on per-sensor threshold crossings, with edge detection, cooldown, and fail-open error handling.

**Architecture:** Pure factory returning a `SystemSignalSource`. Single shared polling loop, lazy start on first `watch()`, lazy clear on last unsubscribe. Per-sensor edge state + per-sensor cooldown timestamp. Injectable `now`/`setInterval`/`clearInterval` for deterministic tests.

**Tech Stack:** TypeScript 6 strict, Bun 1.3, `bun:test`, zero deps beyond `@koi/core`.

**Spec:** `docs/superpowers/specs/2026-05-10-governance-signal-source-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/lib/proactive/src/governance-signal-source.ts` (new) | Factory + types + polling loop + edge/cooldown state |
| `packages/lib/proactive/src/governance-signal-source.test.ts` (new) | All 14 unit tests |
| `packages/lib/proactive/src/index.ts` (modify) | Public exports |
| `docs/L2/proactive.md` (modify) | Composition triggers section |

---

## Task 1: Skeleton + first failing test (above-crossing emits)

**Files:**
- Create: `packages/lib/proactive/src/governance-signal-source.ts`
- Create: `packages/lib/proactive/src/governance-signal-source.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/lib/proactive/src/governance-signal-source.test.ts`:

```typescript
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
    reading: (name): SensorReading | undefined => {
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
```

- [ ] **Step 2: Stub the factory so the test fails on assertion, not import**

Create `packages/lib/proactive/src/governance-signal-source.ts`:

```typescript
import type { GovernanceController, SystemSignal, SystemSignalSource } from "@koi/core";

export interface GovernanceThreshold {
  readonly sensor: string;
  readonly limit: number;
  readonly direction: "above" | "below";
  readonly cooldownMs?: number;
}

export interface GovernanceSignalSourceConfig {
  readonly controller: GovernanceController;
  readonly thresholds: readonly GovernanceThreshold[];
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

export function createGovernanceSignalSource(
  _config: GovernanceSignalSourceConfig,
): SystemSignalSource {
  return {
    name: "governance",
    watch: () => () => {},
  };
}
```

- [ ] **Step 3: Run test to verify failure**

Run: `cd packages/lib/proactive && bun test governance-signal-source.test.ts`
Expected: FAIL — `expect(got).toEqual([...])` fails because stub never emits.

- [ ] **Step 4: Implement the minimal real factory**

Replace `packages/lib/proactive/src/governance-signal-source.ts` with the full implementation:

```typescript
/**
 * Governance threshold → SystemSignal adapter.
 *
 * Polls a GovernanceController at a fixed interval, detects threshold
 * crossings (rising/falling edges), and emits SystemSignal{kind:"governance"}
 * on each crossing. Per-sensor cooldown debounces repeated crossings.
 *
 * Single shared polling loop fans out to all subscribers. Loop starts on
 * first watch() and is cleared on last unsubscribe.
 */

import type { GovernanceController, SystemSignal, SystemSignalSource } from "@koi/core";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_COOLDOWN_MS = 60_000;

export interface GovernanceThreshold {
  readonly sensor: string;
  readonly limit: number;
  readonly direction: "above" | "below";
  readonly cooldownMs?: number;
}

export interface GovernanceSignalSourceConfig {
  readonly controller: GovernanceController;
  readonly thresholds: readonly GovernanceThreshold[];
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

interface Subscriber {
  readonly handler: (signal: SystemSignal) => void;
  readonly onError: ((err: unknown) => void) | undefined;
}

interface SensorState {
  /** True when the most recent reading was past the threshold (outside-bound). */
  outside: boolean;
  /** Wall-clock ms of the last emission for this sensor; -Infinity = never. */
  lastEmittedAt: number;
}

function isCrossed(value: number, threshold: GovernanceThreshold): boolean {
  return threshold.direction === "above" ? value > threshold.limit : value < threshold.limit;
}

export function createGovernanceSignalSource(
  config: GovernanceSignalSourceConfig,
): SystemSignalSource {
  const {
    controller,
    thresholds,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = Date.now,
    setInterval: setIntervalFn = globalThis.setInterval,
    clearInterval: clearIntervalFn = globalThis.clearInterval,
  } = config;

  const subscribers = new Set<Subscriber>();
  const sensorState = new Map<string, SensorState>();
  let intervalHandle: ReturnType<typeof globalThis.setInterval> | undefined;

  function getOrInitState(sensor: string): SensorState {
    let s = sensorState.get(sensor);
    if (s === undefined) {
      s = { outside: false, lastEmittedAt: Number.NEGATIVE_INFINITY };
      sensorState.set(sensor, s);
    }
    return s;
  }

  function emit(signal: SystemSignal): void {
    for (const sub of subscribers) {
      queueMicrotask(() => {
        try {
          sub.handler(signal);
        } catch (e: unknown) {
          sub.onError?.(e);
        }
      });
    }
  }

  function notifyError(err: unknown): void {
    for (const sub of subscribers) {
      sub.onError?.(err);
    }
  }

  function poll(): void {
    const t = now();
    for (const threshold of thresholds) {
      let reading;
      try {
        reading = controller.reading(threshold.sensor);
      } catch (e: unknown) {
        notifyError(e);
        continue;
      }
      if (reading === undefined) {
        notifyError(
          new Error(`governance signal source: unknown sensor '${threshold.sensor}'`),
        );
        continue;
      }
      const state = getOrInitState(threshold.sensor);
      const crossed = isCrossed(reading.current, threshold);
      if (!crossed) {
        // Re-entry to inside-bound arms the sensor for the next emission.
        state.outside = false;
        continue;
      }
      // Currently outside-bound. Only emit on the *transition* (rising edge).
      if (state.outside) continue;
      state.outside = true;
      const cooldown = threshold.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      if (t - state.lastEmittedAt < cooldown) continue;
      state.lastEmittedAt = t;
      emit({
        kind: "governance",
        sensor: threshold.sensor,
        value: reading.current,
        limit: threshold.limit,
        direction: threshold.direction,
        emittedAt: t,
      });
    }
  }

  function startIntervalIfNeeded(): void {
    if (intervalHandle !== undefined) return;
    intervalHandle = setIntervalFn(poll, pollIntervalMs);
  }

  function stopIntervalIfIdle(): void {
    if (subscribers.size > 0 || intervalHandle === undefined) return;
    clearIntervalFn(intervalHandle);
    intervalHandle = undefined;
    sensorState.clear();
  }

  return {
    name: "governance",
    watch: (handler, options) => {
      const sub: Subscriber = { handler, onError: options?.onError };
      subscribers.add(sub);
      startIntervalIfNeeded();
      return () => {
        subscribers.delete(sub);
        stopIntervalIfIdle();
      };
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/lib/proactive && bun test governance-signal-source.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add packages/lib/proactive/src/governance-signal-source.ts packages/lib/proactive/src/governance-signal-source.test.ts
git commit -m "feat(proactive): governance signal source with above-threshold edge detection"
```

---

## Task 2: Edge detection + re-entry tests

**Files:**
- Modify: `packages/lib/proactive/src/governance-signal-source.test.ts`

- [ ] **Step 1: Add tests 2 and 3 inside the existing `describe`**

```typescript
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
      thresholds: [
        { sensor: "error_rate", limit: 0.3, direction: "above", cooldownMs: 1000 },
      ],
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
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test governance-signal-source.test.ts`
Expected: PASS (3 tests).

---

## Task 3: Cooldown suppression test

**Files:**
- Modify: `packages/lib/proactive/src/governance-signal-source.test.ts`

- [ ] **Step 1: Add test**

```typescript
  test("re-entry then re-crossing within cooldown is suppressed", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([["error_rate", 0.4]]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [
        { sensor: "error_rate", limit: 0.3, direction: "above", cooldownMs: 60_000 },
      ],
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
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test governance-signal-source.test.ts`
Expected: PASS (4 tests).

---

## Task 4: "below" direction test

**Files:**
- Modify: `packages/lib/proactive/src/governance-signal-source.test.ts`

- [ ] **Step 1: Add test**

```typescript
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
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test governance-signal-source.test.ts`
Expected: PASS (5 tests).

---

## Task 5: Multiple sensors fire independently

**Files:**
- Modify: `packages/lib/proactive/src/governance-signal-source.test.ts`

- [ ] **Step 1: Add test**

```typescript
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
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test governance-signal-source.test.ts`
Expected: PASS (6 tests).

---

## Task 6: Multiple subscribers fan-out

**Files:**
- Modify: `packages/lib/proactive/src/governance-signal-source.test.ts`

- [ ] **Step 1: Add test**

```typescript
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
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test governance-signal-source.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 3: Commit Tasks 2–6**

```bash
git add packages/lib/proactive/src/governance-signal-source.test.ts
git commit -m "test(proactive): edge, cooldown, below, multi-sensor, multi-subscriber for governance source"
```

---

## Task 7: Lifecycle tests (interval start/stop)

**Files:**
- Modify: `packages/lib/proactive/src/governance-signal-source.test.ts`

- [ ] **Step 1: Add tests 8 and 9**

```typescript
  test("first watch starts the interval; second watch does not double-start", () => {
    const clock = makeClock();
    const timer = makeTimer();
    const source = createGovernanceSignalSource({
      controller: makeController(new Map()),
      thresholds: [],
      now: clock.now,
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
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
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
    });

    let firstBatch: SystemSignal[] = [];
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
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test governance-signal-source.test.ts`
Expected: PASS (9 tests).

---

## Task 8: Error-handling tests (10, 11, 12)

**Files:**
- Modify: `packages/lib/proactive/src/governance-signal-source.test.ts`

- [ ] **Step 1: Add three tests**

```typescript
  test("unknown sensor name notifies onError, no throw, no signal", async () => {
    const clock = makeClock();
    const timer = makeTimer();
    const source = createGovernanceSignalSource({
      controller: makeController(new Map()),
      thresholds: [{ sensor: "ghost", limit: 1, direction: "above" }],
      now: clock.now,
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
    });
    const got: SystemSignal[] = [];
    const errors: unknown[] = [];
    source.watch(
      (s) => got.push(s),
      { onError: (e) => errors.push(e) },
    );

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
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
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
      reading: (name) => {
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
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
    });
    const got: SystemSignal[] = [];
    const errors: unknown[] = [];
    source.watch(
      (s) => got.push(s),
      { onError: (e) => errors.push(e) },
    );

    timer.fire();
    await clock.tick();
    expect(errors).toHaveLength(1);
    expect(got).toHaveLength(0);

    timer.fire();
    await clock.tick();
    expect(got).toHaveLength(1);
  });
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test governance-signal-source.test.ts`
Expected: PASS (12 tests).

---

## Task 9: Per-threshold cooldown override + name tests

**Files:**
- Modify: `packages/lib/proactive/src/governance-signal-source.test.ts`

- [ ] **Step 1: Add two tests**

```typescript
  test("per-threshold cooldownMs overrides default", async () => {
    const clock = makeClock(1_700_000_000_000);
    const timer = makeTimer();
    const readings = new Map<string, number>([["error_rate", 0.4]]);
    const source = createGovernanceSignalSource({
      controller: makeController(readings),
      thresholds: [
        { sensor: "error_rate", limit: 0.3, direction: "above", cooldownMs: 100 },
      ],
      now: clock.now,
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
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
      setInterval: timer.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: timer.clearInterval as unknown as typeof globalThis.clearInterval,
    });
    expect(source.name).toBe("governance");
  });
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test governance-signal-source.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 3: Commit Tasks 7–9**

```bash
git add packages/lib/proactive/src/governance-signal-source.test.ts
git commit -m "test(proactive): lifecycle, error handling, cooldown override for governance source"
```

---

## Task 10: Public exports

**Files:**
- Modify: `packages/lib/proactive/src/index.ts`

- [ ] **Step 1: Add exports**

Append to `packages/lib/proactive/src/index.ts`:

```typescript
export {
  createGovernanceSignalSource,
  type GovernanceSignalSourceConfig,
  type GovernanceThreshold,
} from "./governance-signal-source.js";
```

- [ ] **Step 2: Verify**

Run: `cd packages/lib/proactive && bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/proactive/src/index.ts
git commit -m "feat(proactive): export createGovernanceSignalSource surface"
```

---

## Task 11: Docs

**Files:**
- Modify: `docs/L2/proactive.md`

- [ ] **Step 1: Append a Composition Triggers section**

Read `docs/L2/proactive.md` first, then append at the end (or under an existing "Composition triggers" / SystemSignal section if one already exists):

```markdown
## Composition triggers — `createGovernanceSignalSource`

Wraps a `GovernanceController` as a `SystemSignalSource`. Polls the
controller at `pollIntervalMs` (default 1 s), detects per-sensor
threshold crossings (rising or falling edges), and emits
`SystemSignal{kind: "governance"}` to subscribers. Per-sensor cooldown
(default 60 s) suppresses repeated emissions.

```typescript
import { createGovernanceSignalSource } from "@koi/proactive";

const source = createGovernanceSignalSource({
  controller: governance,
  thresholds: [
    { sensor: "error_rate", limit: 0.3, direction: "above" },
    { sensor: "context_occupancy", limit: 0.8, direction: "above", cooldownMs: 30_000 },
    { sensor: "spawn_count", limit: 1, direction: "below" },
  ],
});

const off = source.watch(
  (signal) => planner.handle(signal),
  { onError: (e) => log.warn({ err: e }, "governance signal source error") },
);
// later: off()
```

The source uses a single shared polling loop. It starts on the first
`watch()` call and is cleared on the last unsubscribe; subsequent
`watch()` calls reuse the running loop. Per-sensor edge state resets
when the loop stops, so a fresh subscription treats the next reading
as the start of a new crossing series.

Failure modes are fail-open: unknown sensor names, controller read
exceptions, and handler exceptions all forward to the subscriber's
`onError` callback and the polling loop continues.
```

- [ ] **Step 2: Commit**

```bash
git add docs/L2/proactive.md
git commit -m "docs(proactive): document createGovernanceSignalSource"
```

---

## Task 12: Final verification

- [ ] **Step 1: Full proactive package**

Run: `cd packages/lib/proactive && bun run typecheck && bun run lint && bun test`
Expected: PASS — all 14 new tests + existing suite green.

- [ ] **Step 2: Layer check**

Run: `bun run check:layers`
Expected: PASS.

---

## Self-Review Notes

- Spec coverage: every spec table item maps to a Task (1: above/shape; 2: stays-past + re-entry; 3: cooldown; 4: below; 5: multi-sensor; 6: multi-subscriber; 7: lifecycle; 8: errors; 9: per-threshold cooldown + name).
- No placeholders.
- Type consistency: `GovernanceThreshold`, `GovernanceSignalSourceConfig`, `Subscriber` used consistently. `SensorState` is internal-only.
- One nuance: Task 7's "last unsubscribe clears state" test asserts that re-subscribing detects 0.4 as a fresh crossing. This is the documented spec behavior (state reset on idle). If the implementation differed, the test catches it.
