import { describe, expect, mock, test } from "bun:test";
import type { GovernanceController, GovernanceSnapshot, SystemSignal } from "@koi/core";
import { createGovernanceSignalSource } from "./governance.js";

type MutableGovernanceController = {
  -readonly [K in keyof GovernanceController]: GovernanceController[K];
};

function createController(readings: GovernanceSnapshot["readings"]): GovernanceController {
  return {
    check: async () => ({ ok: true }),
    checkAll: async () => ({ ok: true }),
    record: async () => {},
    snapshot: async () => ({
      timestamp: 100,
      readings,
      healthy: true,
      violations: [],
    }),
    variables: () => new Map(),
    reading: (name) => readings.find((reading) => reading.name === name),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

function sequenceSnapshots(
  snapshots: readonly Promise<GovernanceSnapshot>[],
): () => Promise<GovernanceSnapshot> {
  let index = 0;
  return async () => {
    const snapshot = snapshots[Math.min(index++, snapshots.length - 1)];
    if (snapshot === undefined) {
      throw new Error("expected at least one snapshot");
    }
    return snapshot;
  };
}

describe("createGovernanceSignalSource", () => {
  test("emits only on threshold crossing", async () => {
    let current = 0.1;
    const controller: MutableGovernanceController = createController([
      { name: "error_rate", current, limit: 1, utilization: current },
    ]);
    controller.snapshot = async () => ({
      timestamp: 100,
      readings: [{ name: "error_rate", current, limit: 1, utilization: current }],
      healthy: true,
      violations: [],
    });

    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      { pollIntervalMs: 1, now: () => 100 },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));

    await new Promise((resolve) => setTimeout(resolve, 5));
    current = 0.4;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => queueMicrotask(resolve));

    stop();
    expect(seen).toEqual([
      {
        kind: "governance",
        sensor: "error_rate",
        value: 0.4,
        limit: 0.3,
        direction: "above",
        emittedAt: 100,
      },
    ]);
  });

  test("replay emits an already-alerting threshold immediately", async () => {
    const controller: MutableGovernanceController = createController([
      { name: "context_occupancy", current: 0.92, limit: 1, utilization: 0.92 },
    ]);
    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "context_occupancy", limit: 0.8, direction: "above" }],
      { now: () => 200 },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal), { replay: true });
    await new Promise((resolve) => queueMicrotask(resolve));

    stop();
    expect(seen[0]).toEqual({
      kind: "governance",
      sensor: "context_occupancy",
      value: 0.92,
      limit: 0.8,
      direction: "above",
      emittedAt: 200,
    });
  });

  test("snapshot failures report to onError and do not throw", async () => {
    const err = new Error("boom");
    const controller = {
      ...createController([]),
      snapshot: async () => {
        throw err;
      },
    } satisfies GovernanceController;

    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      { pollIntervalMs: 1 },
    );

    const onError = mock(() => {});
    const stop = source.watch(() => {}, { onError });
    await new Promise((resolve) => setTimeout(resolve, 5));
    stop();

    expect(onError).toHaveBeenCalledWith(err);
  });

  test("enforces cooldown before emitting a new crossing", async () => {
    let now = 100;
    let current = 0.1;
    const controller: MutableGovernanceController = createController([
      { name: "error_rate", current, limit: 1, utilization: current },
    ]);
    controller.snapshot = async () => ({
      timestamp: now,
      readings: [{ name: "error_rate", current, limit: 1, utilization: current }],
      healthy: true,
      violations: [],
    });

    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate", limit: 0.3, direction: "above", cooldownMs: 50 }],
      { pollIntervalMs: 1, now: () => now },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));

    await new Promise((resolve) => setTimeout(resolve, 5));

    now = 110;
    current = 0.4;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => queueMicrotask(resolve));

    now = 120;
    current = 0.1;
    await new Promise((resolve) => setTimeout(resolve, 5));

    now = 140;
    current = 0.45;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => queueMicrotask(resolve));

    now = 170;
    current = 0.1;
    await new Promise((resolve) => setTimeout(resolve, 5));

    now = 180;
    current = 0.5;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => queueMicrotask(resolve));

    stop();
    expect(seen).toEqual([
      {
        kind: "governance",
        sensor: "error_rate",
        value: 0.4,
        limit: 0.3,
        direction: "above",
        emittedAt: 110,
      },
      {
        kind: "governance",
        sensor: "error_rate",
        value: 0.5,
        limit: 0.3,
        direction: "above",
        emittedAt: 180,
      },
    ]);
  });

  test("coalesces equivalent thresholds that differ only by cooldown", async () => {
    let now = 100;
    let current = 0.1;
    const controller: MutableGovernanceController = createController([
      { name: "error_rate", current, limit: 1, utilization: current },
    ]);
    controller.snapshot = async () => ({
      timestamp: now,
      readings: [{ name: "error_rate", current, limit: 1, utilization: current }],
      healthy: true,
      violations: [],
    });

    const source = createGovernanceSignalSource(
      controller,
      [
        { sensor: "error_rate", limit: 0.3, direction: "above", cooldownMs: 0 },
        { sensor: "error_rate", limit: 0.3, direction: "above", cooldownMs: 100 },
      ],
      { pollIntervalMs: 1, now: () => now },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));

    await new Promise((resolve) => setTimeout(resolve, 5));

    now = 110;
    current = 0.4;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => queueMicrotask(resolve));

    now = 120;
    current = 0.1;
    await new Promise((resolve) => setTimeout(resolve, 5));

    now = 150;
    current = 0.45;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => queueMicrotask(resolve));

    stop();
    expect(seen).toEqual([
      {
        kind: "governance",
        sensor: "error_rate",
        value: 0.4,
        limit: 0.3,
        direction: "above",
        emittedAt: 110,
      },
      {
        kind: "governance",
        sensor: "error_rate",
        value: 0.45,
        limit: 0.3,
        direction: "above",
        emittedAt: 150,
      },
    ]);
  });

  test("unsubscribe clears polling and disconnects only once", async () => {
    const snapshot = mock(async () => ({
      timestamp: 100,
      readings: [{ name: "error_rate", current: 0.1, limit: 1, utilization: 0.1 }],
      healthy: true,
      violations: [],
    }));
    const controller = {
      ...createController([]),
      snapshot,
    } satisfies GovernanceController;

    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      { pollIntervalMs: 2, now: () => 100 },
    );

    const onDisconnect = mock(() => {});
    const stop = source.watch(() => {}, { onDisconnect });

    await new Promise((resolve) => setTimeout(resolve, 8));
    const callsBeforeStop = snapshot.mock.calls.length;

    stop();
    stop();

    await new Promise((resolve) => setTimeout(resolve, 8));

    expect(snapshot.mock.calls.length).toBe(callsBeforeStop);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  test("stop prevents an in-flight replay poll from emitting after unsubscribe", async () => {
    const deferred = createDeferred<GovernanceSnapshot>();
    const controller = {
      ...createController([]),
      snapshot: mock(async () => deferred.promise),
    } satisfies GovernanceController;

    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      { now: () => 300 },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal), { replay: true });

    stop();
    deferred.resolve({
      timestamp: 300,
      readings: [{ name: "error_rate", current: 0.4, limit: 1, utilization: 0.4 }],
      healthy: true,
      violations: [],
    });
    await deferred.promise;
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(seen).toEqual([]);
  });

  test("stop prevents an already-queued governance microtask from reaching the handler", async () => {
    const controller: MutableGovernanceController = createController([
      { name: "error_rate", current: 0.4, limit: 1, utilization: 0.4 },
    ]);
    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      { now: () => 320 },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal), { replay: true });

    await Promise.resolve();
    stop();
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(seen).toEqual([]);
  });

  test("ignores stale overlapping poll completions", async () => {
    const first = createDeferred<GovernanceSnapshot>();
    const secondStarted = createDeferred<void>();
    const thirdStarted = createDeferred<void>();
    const fourthStarted = createDeferred<void>();
    const snapshots = [
      Promise.resolve({
        timestamp: 390,
        readings: [{ name: "error_rate", current: 0.4, limit: 1, utilization: 0.4 }],
        healthy: true,
        violations: [],
      }),
      first.promise,
      Promise.resolve({
        timestamp: 401,
        readings: [{ name: "error_rate", current: 0.1, limit: 1, utilization: 0.1 }],
        healthy: true,
        violations: [],
      }),
      Promise.resolve({
        timestamp: 402,
        readings: [{ name: "error_rate", current: 0.45, limit: 1, utilization: 0.45 }],
        healthy: true,
        violations: [],
      }),
    ];
    const nextSnapshot = sequenceSnapshots(snapshots);
    let callCount = 0;
    const controller = {
      ...createController([]),
      snapshot: mock(async () => {
        callCount += 1;
        if (callCount === 2) secondStarted.resolve();
        if (callCount === 3) thirdStarted.resolve();
        if (callCount === 4) fourthStarted.resolve();
        return nextSnapshot();
      }),
    } satisfies GovernanceController;
    let intervalCallback: (() => void) | undefined;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0]) => {
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;

    try {
      const source = createGovernanceSignalSource(
        controller,
        [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
        { pollIntervalMs: 1, now: () => 450 },
      );

      const seen: SystemSignal[] = [];
      const stop = source.watch((signal) => seen.push(signal), { replay: true });
      await new Promise((resolve) => queueMicrotask(resolve));

      intervalCallback?.();
      await secondStarted.promise;
      intervalCallback?.();
      first.resolve({
        timestamp: 400,
        readings: [{ name: "error_rate", current: 0.4, limit: 1, utilization: 0.4 }],
        healthy: true,
        violations: [],
      });
      await first.promise;
      await thirdStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => queueMicrotask(resolve));

      intervalCallback?.();
      await fourthStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => queueMicrotask(resolve));

      stop();
      expect(seen).toEqual([
        {
          kind: "governance",
          sensor: "error_rate",
          value: 0.4,
          limit: 0.3,
          direction: "above",
          emittedAt: 450,
        },
        {
          kind: "governance",
          sensor: "error_rate",
          value: 0.45,
          limit: 0.3,
          direction: "above",
          emittedAt: 450,
        },
      ]);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("processes recovery before a newer re-alert request", async () => {
    const recovery = createDeferred<GovernanceSnapshot>();
    const secondStarted = createDeferred<void>();
    const thirdStarted = createDeferred<void>();
    const snapshots = [
      Promise.resolve({
        timestamp: 700,
        readings: [{ name: "error_rate", current: 0.4, limit: 1, utilization: 0.4 }],
        healthy: true,
        violations: [],
      }),
      recovery.promise,
      Promise.resolve({
        timestamp: 702,
        readings: [{ name: "error_rate", current: 0.45, limit: 1, utilization: 0.45 }],
        healthy: true,
        violations: [],
      }),
    ];
    const nextSnapshot = sequenceSnapshots(snapshots);
    let callCount = 0;
    const controller = {
      ...createController([]),
      snapshot: mock(async () => {
        callCount += 1;
        if (callCount === 2) secondStarted.resolve();
        if (callCount === 3) thirdStarted.resolve();
        return nextSnapshot();
      }),
    } satisfies GovernanceController;
    let intervalCallback: (() => void) | undefined;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0]) => {
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;

    try {
      const source = createGovernanceSignalSource(
        controller,
        [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
        { pollIntervalMs: 1, now: () => 750 },
      );

      const seen: SystemSignal[] = [];
      const stop = source.watch((signal) => seen.push(signal), { replay: true });
      await new Promise((resolve) => queueMicrotask(resolve));

      intervalCallback?.();
      await secondStarted.promise;

      intervalCallback?.();
      recovery.resolve({
        timestamp: 701,
        readings: [{ name: "error_rate", current: 0.1, limit: 1, utilization: 0.1 }],
        healthy: true,
        violations: [],
      });
      await recovery.promise;
      await thirdStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => queueMicrotask(resolve));

      stop();
      expect(seen).toEqual([
        {
          kind: "governance",
          sensor: "error_rate",
          value: 0.4,
          limit: 0.3,
          direction: "above",
          emittedAt: 750,
        },
        {
          kind: "governance",
          sensor: "error_rate",
          value: 0.45,
          limit: 0.3,
          direction: "above",
          emittedAt: 750,
        },
      ]);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("does not re-enter snapshot while a poll is already in flight", async () => {
    const deferred = createDeferred<GovernanceSnapshot>();
    const snapshot = mock(async () => deferred.promise);
    const controller = {
      ...createController([]),
      snapshot,
    } satisfies GovernanceController;

    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      { pollIntervalMs: 1, now: () => 500 },
    );

    const stop = source.watch(() => {}, { replay: true });

    await new Promise((resolve) => setTimeout(resolve, 5));
    deferred.resolve({
      timestamp: 500,
      readings: [],
      healthy: true,
      violations: [],
    });
    await deferred.promise;
    await new Promise((resolve) => queueMicrotask(resolve));

    stop();

    expect(snapshot.mock.calls.length).toBeLessThanOrEqual(2);
  });

  test("supports wildcard sensor thresholds through adapter matching", async () => {
    const controller: MutableGovernanceController = createController([
      { name: "error_rate_api", current: 0.41, limit: 1, utilization: 0.41 },
    ]);
    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate_*", limit: 0.3, direction: "above" }],
      { now: () => 250 },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal), { replay: true });
    await new Promise((resolve) => queueMicrotask(resolve));

    stop();
    expect(seen).toEqual([
      {
        kind: "governance",
        sensor: "error_rate_*",
        value: 0.41,
        limit: 0.3,
        direction: "above",
        emittedAt: 250,
      },
    ]);
  });

  test("wildcard thresholds choose an alerting match beyond the first reading", async () => {
    const controller: MutableGovernanceController = createController([
      { name: "error_rate_api", current: 0.1, limit: 1, utilization: 0.1 },
      { name: "error_rate_worker", current: 0.52, limit: 1, utilization: 0.52 },
    ]);
    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate_*", limit: 0.3, direction: "above" }],
      { now: () => 275 },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal), { replay: true });
    await new Promise((resolve) => queueMicrotask(resolve));

    stop();
    expect(seen).toEqual([
      {
        kind: "governance",
        sensor: "error_rate_*",
        value: 0.52,
        limit: 0.3,
        direction: "above",
        emittedAt: 275,
      },
    ]);
  });

  test("below-direction wildcard thresholds choose the lowest alerting match", async () => {
    const controller: MutableGovernanceController = createController([
      { name: "context_occupancy_api", current: 0.4, limit: 1, utilization: 0.4 },
      { name: "context_occupancy_worker", current: 0.2, limit: 1, utilization: 0.2 },
      { name: "context_occupancy_cache", current: 0.7, limit: 1, utilization: 0.7 },
    ]);
    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "context_occupancy_*", limit: 0.5, direction: "below" }],
      { now: () => 610 },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal), { replay: true });
    await new Promise((resolve) => queueMicrotask(resolve));

    stop();
    expect(seen).toEqual([
      {
        kind: "governance",
        sensor: "context_occupancy_*",
        value: 0.2,
        limit: 0.5,
        direction: "below",
        emittedAt: 610,
      },
    ]);
  });

  test("sampleRateMs does not permanently consume a throttled threshold crossing", async () => {
    let now = 100;
    let errorRate = 0.1;
    let contextOccupancy = 0.1;
    const controller: MutableGovernanceController = createController([
      { name: "error_rate", current: errorRate, limit: 1, utilization: errorRate },
      {
        name: "context_occupancy",
        current: contextOccupancy,
        limit: 1,
        utilization: contextOccupancy,
      },
    ]);
    controller.snapshot = async () => ({
      timestamp: now,
      readings: [
        { name: "error_rate", current: errorRate, limit: 1, utilization: errorRate },
        {
          name: "context_occupancy",
          current: contextOccupancy,
          limit: 1,
          utilization: contextOccupancy,
        },
      ],
      healthy: true,
      violations: [],
    });

    const source = createGovernanceSignalSource(
      controller,
      [
        { sensor: "error_rate", limit: 0.3, direction: "above" },
        { sensor: "context_occupancy", limit: 0.3, direction: "above" },
      ],
      { pollIntervalMs: 1, now: () => now },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal), { sampleRateMs: 50 });

    await new Promise((resolve) => setTimeout(resolve, 5));

    now = 110;
    errorRate = 0.4;
    contextOccupancy = 0.6;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => queueMicrotask(resolve));

    now = 170;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => queueMicrotask(resolve));

    stop();
    expect(seen).toEqual([
      {
        kind: "governance",
        sensor: "error_rate",
        value: 0.4,
        limit: 0.3,
        direction: "above",
        emittedAt: 110,
      },
      {
        kind: "governance",
        sensor: "context_occupancy",
        value: 0.6,
        limit: 0.3,
        direction: "above",
        emittedAt: 170,
      },
    ]);
  });
});
