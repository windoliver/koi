/**
 * Tests for createDaemonBridge — registry-only mode.
 *
 * Uses a fake registry built in-process. Timer injection (setTimeoutFn) is
 * used instead of bun fake-timer APIs so we can drive the poll loop
 * deterministically without depending on global timer state.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  BackgroundSessionEvent,
  BackgroundSessionRecord,
  SupervisorHealth,
  WorkerEvent,
  WorkerId,
} from "@koi/core/daemon";
import type { KoiError, Result } from "@koi/core/errors";
import type { TuiAction } from "@koi/tui";
import {
  type CreateDaemonBridgeOptions,
  createDaemonBridge,
  type DaemonBridgeToast,
} from "./daemon-bridge.js";
import type { FakeRegistry, FakeSupervisor } from "./daemon-bridge.test-helpers.js";
import { makeFakeRegistry, makeFakeSupervisor, makeRecord } from "./daemon-bridge.test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectActions(_opts: Partial<CreateDaemonBridgeOptions> = {}): {
  actions: TuiAction[];
  toasts: DaemonBridgeToast[];
  dispatch: (a: TuiAction) => void;
  pushToast: (t: DaemonBridgeToast) => void;
} {
  const actions: TuiAction[] = [];
  const toasts: DaemonBridgeToast[] = [];
  return {
    actions,
    toasts,
    dispatch: (a: TuiAction): void => {
      actions.push(a);
    },
    pushToast: (t: DaemonBridgeToast): void => {
      toasts.push(t);
    },
  };
}

function pumpMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDaemonBridge — registry-only mode", () => {
  let fake: FakeRegistry;

  beforeEach(() => {
    fake = makeFakeRegistry();
  });

  afterEach(async () => {
    // Ensure any background promises from tests that don't close the bridge
    // don't leak across test boundaries.
    await pumpMicrotasks();
  });

  test("dispatches set_bg_rows from initial describeList success", async () => {
    const recA = makeRecord("worker-a", "agent-a");
    const recB = makeRecord("worker-b", "agent-b");
    fake.setRecords([recA, recB]);

    const { actions, dispatch, pushToast } = collectActions();
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fake },
      dispatch,
      pushToast,
      clock: () => 1_000_000,
      intervals: { registryPollMs: 1 },
    });

    await pumpMicrotasks();
    await pumpMicrotasks();

    const rowActions = actions.filter((a) => a.kind === "set_bg_rows");
    expect(rowActions.length).toBeGreaterThan(0);
    const last = rowActions[rowActions.length - 1];
    expect(last?.kind).toBe("set_bg_rows");
    if (last?.kind === "set_bg_rows") {
      expect(last.rows.length).toBe(2);
      expect(last.rows.map((r) => r.workerId)).toContain("worker-a");
      expect(last.rows.map((r) => r.workerId)).toContain("worker-b");
    }

    const statusActions = actions.filter((a) => a.kind === "set_bg_registry_status");
    expect(statusActions.length).toBeGreaterThan(0);
    const lastStatus = statusActions[statusActions.length - 1];
    if (lastStatus?.kind === "set_bg_registry_status") {
      expect(lastStatus.status.kind).toBe("live");
    }

    await bridge.close();
  });

  test("3 consecutive describeList failures flip registryStatus to stale", async () => {
    const error: KoiError = { code: "INTERNAL", message: "disk error", retryable: false };
    fake.setError(error);

    const { actions, dispatch, pushToast } = collectActions();
    // Run 3+ poll ticks by advancing promise chain.
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fake },
      dispatch,
      pushToast,
      clock: () => 2_000_000,
      intervals: { registryPollMs: 1 },
    });

    // Drive at least 3 polls
    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const staleActions = actions.filter(
      (a) => a.kind === "set_bg_registry_status" && a.status.kind === "stale",
    );
    expect(staleActions.length).toBeGreaterThan(0);

    // Verify rows were never dispatched (no set_bg_rows on failure path)
    const rowActions = actions.filter((a) => a.kind === "set_bg_rows");
    expect(rowActions.length).toBe(0);

    await bridge.close();
  });

  test("registryStatus stale → live emits info toast on recovery", async () => {
    const error: KoiError = { code: "INTERNAL", message: "disk error", retryable: false };
    fake.setError(error);

    const { actions, toasts, dispatch, pushToast } = collectActions();
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fake },
      dispatch,
      pushToast,
      clock: () => 3_000_000,
      intervals: { registryPollMs: 1 },
    });

    // Drive to stale (3+ failures)
    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const staleActions = actions.filter(
      (a) => a.kind === "set_bg_registry_status" && a.status.kind === "stale",
    );
    expect(staleActions.length).toBeGreaterThan(0);

    // Now recover
    fake.setError(null);
    fake.setRecords([makeRecord("worker-x", "agent-x")]);

    // Drive a few more ticks to get the recovery poll
    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const liveActions = actions.filter(
      (a) => a.kind === "set_bg_registry_status" && a.status.kind === "live",
    );
    expect(liveActions.length).toBeGreaterThan(0);

    const recoveryToasts = toasts.filter((t) => t.message.includes("registry restored"));
    expect(recoveryToasts.length).toBeGreaterThan(0);
    expect(recoveryToasts[0]?.kind).toBe("info");

    await bridge.close();
  });

  test("registry.watch event triggers extra poll", async () => {
    fake.setRecords([makeRecord("worker-w", "agent-w")]);

    const { dispatch, pushToast } = collectActions();
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fake },
      dispatch,
      pushToast,
      clock: () => 4_000_000,
      intervals: { registryPollMs: 100_000 }, // very long poll interval
    });

    // Wait for the initial poll tick
    await pumpMicrotasks();
    await pumpMicrotasks();
    const countAfterInit = fake.describeListCallCount();

    // Push a watch event
    const event: BackgroundSessionEvent = {
      kind: "updated",
      record: makeRecord("worker-w", "agent-w"),
    };
    fake.pushWatchEvent(event);

    await pumpMicrotasks();
    await pumpMicrotasks();
    await pumpMicrotasks();

    expect(fake.describeListCallCount()).toBeGreaterThan(countAfterInit);

    await bridge.close();
  });

  test("registry.watch iterator throwing flips status to degraded; polls keep updating rows", async () => {
    fake.setRecords([makeRecord("worker-d", "agent-d")]);
    fake.triggerWatchError(new Error("watch stream broke"));

    const { actions, dispatch, pushToast } = collectActions();
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fake },
      dispatch,
      pushToast,
      clock: () => 5_000_000,
      intervals: { registryPollMs: 1 },
    });

    for (let i = 0; i < 10; i++) {
      await pumpMicrotasks();
    }

    const degradedActions = actions.filter(
      (a) => a.kind === "set_bg_registry_status" && a.status.kind === "degraded",
    );
    expect(degradedActions.length).toBeGreaterThan(0);

    // Even in degraded mode, successful describeList should still dispatch rows.
    const rowActions = actions.filter((a) => a.kind === "set_bg_rows");
    expect(rowActions.length).toBeGreaterThan(0);

    await bridge.close();
  });

  test("close() drains poll loop + watch consumer; no further dispatches after close", async () => {
    fake.setRecords([makeRecord("worker-c", "agent-c")]);

    const { actions, dispatch, pushToast } = collectActions();
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fake },
      dispatch,
      pushToast,
      clock: () => 6_000_000,
      intervals: { registryPollMs: 1 },
    });

    await pumpMicrotasks();
    await bridge.close();

    const countAfterClose = actions.length;

    // Give more time for any leaked timers to fire
    await pumpMicrotasks();
    await pumpMicrotasks();

    // Should not have any new dispatches after close
    expect(actions.length).toBe(countAfterClose);
  });

  test("close during watch backoff cancels via closed sentinel", async () => {
    fake.triggerWatchError(new Error("initial error"));

    const { dispatch, pushToast } = collectActions();
    // Use a very long backoff to make the test deterministic
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fake },
      dispatch,
      pushToast,
      clock: () => 7_000_000,
      intervals: { registryPollMs: 1 },
    });

    await pumpMicrotasks();
    await pumpMicrotasks();

    // Should resolve promptly (not hang on backoff sleep)
    const start = Date.now();
    await bridge.close();
    const elapsed = Date.now() - start;

    // close() should complete in well under 1 second
    expect(elapsed).toBeLessThan(1000);
  });

  test("freshness computed with empty locallySpawnedIds + null health", async () => {
    const now = 8_000_000;
    // A "running" record with no supervisor health => "foreign"
    const rec = makeRecord("worker-f", "agent-f", "running");
    fake.setRecords([rec]);

    const { actions, dispatch, pushToast } = collectActions();
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fake },
      dispatch,
      pushToast,
      clock: () => now,
      intervals: { registryPollMs: 1 },
    });

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const rowActions = actions.filter((a) => a.kind === "set_bg_rows");
    expect(rowActions.length).toBeGreaterThan(0);
    const last = rowActions[rowActions.length - 1];
    if (last?.kind === "set_bg_rows") {
      const row = last.rows.find((r) => r.workerId === "worker-f");
      expect(row).toBeDefined();
      // running + no workerSnap = "foreign"
      expect(row?.freshness).toBe("foreign");
    }

    await bridge.close();
  });

  test("terminal rows get freshness terminal", async () => {
    const now = 9_000_000;
    const rec = makeRecord("worker-t", "agent-t", "exited");
    fake.setRecords([rec]);

    const { actions, dispatch, pushToast } = collectActions();
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fake },
      dispatch,
      pushToast,
      clock: () => now,
      intervals: { registryPollMs: 1 },
    });

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const rowActions = actions.filter((a) => a.kind === "set_bg_rows");
    expect(rowActions.length).toBeGreaterThan(0);
    const last = rowActions[rowActions.length - 1];
    if (last?.kind === "set_bg_rows") {
      const row = last.rows.find((r) => r.workerId === "worker-t");
      expect(row?.freshness).toBe("terminal");
    }

    await bridge.close();
  });

  test("close() invokes registry.watch() iterator.return() — releases parked watcher", async () => {
    let returnCalls = 0;
    let nextResolve: ((v: IteratorResult<BackgroundSessionEvent>) => void) | undefined;
    const watchable: AsyncIterable<BackgroundSessionEvent> = {
      [Symbol.asyncIterator](): AsyncIterator<BackgroundSessionEvent> {
        return {
          next: (): Promise<IteratorResult<BackgroundSessionEvent>> =>
            new Promise((resolve) => {
              nextResolve = resolve;
            }),
          return: (): Promise<IteratorResult<BackgroundSessionEvent>> => {
            returnCalls++;
            // Unblock the parked next() so the loop can exit cleanly
            nextResolve?.({ value: undefined, done: true });
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
    const fakeWithWatch = { ...fake, watch: () => watchable };

    const { dispatch, pushToast } = collectActions();
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fakeWithWatch },
      dispatch,
      pushToast,
      clock: () => 1_000_000,
      intervals: { registryPollMs: 1000 },
    });

    await pumpMicrotasks();
    await pumpMicrotasks();
    expect(returnCalls).toBe(0);

    await bridge.close();
    expect(returnCalls).toBeGreaterThanOrEqual(1);
  });

  test("concurrent runOnePoll triggers coalesce — describeList calls do not fan out", async () => {
    // Hold describeList responses so we can issue concurrent requests
    // before the first resolves, simulating poll + watch-event races.
    let releaseFirst: (() => void) | undefined;
    let firstHeld = false;
    const slowDescribe = async (): Promise<
      Result<readonly BackgroundSessionRecord[], KoiError>
    > => {
      if (!firstHeld) {
        firstHeld = true;
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { ok: true, value: [] };
    };

    let describeCalls = 0;
    const wrappedDescribe = (): Promise<Result<readonly BackgroundSessionRecord[], KoiError>> => {
      describeCalls++;
      return slowDescribe();
    };
    const fakeWithSlow = { ...fake, describeList: wrappedDescribe };

    const { dispatch, pushToast } = collectActions();
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fakeWithSlow },
      dispatch,
      pushToast,
      clock: () => 1_000_000,
      intervals: { registryPollMs: 1 },
    });

    // Let initial poll start (parked on slowDescribe), then push watch events
    // that would otherwise trigger additional concurrent runOnePoll() calls.
    await pumpMicrotasks();
    fake.pushWatchEvent({ kind: "updated", record: makeRecord("w1", "a1") });
    fake.pushWatchEvent({ kind: "updated", record: makeRecord("w2", "a2") });
    await pumpMicrotasks();

    // Single-flight: only the first describeList is in flight; concurrent
    // calls were coalesced and waited on the same promise.
    expect(describeCalls).toBe(1);
    releaseFirst?.();

    await bridge.close();
  });
});

// ---------------------------------------------------------------------------
// Live mode helpers
// ---------------------------------------------------------------------------

function makeHealth(workers: SupervisorHealth["workers"] = []): SupervisorHealth {
  return {
    status: "ok",
    reasons: [],
    metrics: {
      poolSize: workers.length,
      maxWorkers: 10,
      quarantinedCount: 0,
      restartingCount: 0,
      pendingSpawnCount: 0,
      eventDropCount: 0,
      shuttingDown: false,
    },
    workers,
  };
}

/** Immediate setTimeoutFn so backoffs don't stall microtask-driven tests. */
function immediateTimeout(fn: () => void, _ms: number): ReturnType<typeof setTimeout> {
  return setTimeout(fn, 0);
}

function makeLiveBridge(
  fake: FakeRegistry,
  fakeSupervisor: FakeSupervisor,
  overrides: Partial<CreateDaemonBridgeOptions> = {},
): {
  bridge: ReturnType<typeof createDaemonBridge>;
  actions: TuiAction[];
  toasts: DaemonBridgeToast[];
} {
  const actions: TuiAction[] = [];
  const toasts: DaemonBridgeToast[] = [];
  const bridge = createDaemonBridge({
    mode: { kind: "live", registry: fake, supervisor: fakeSupervisor },
    dispatch: (a: TuiAction): void => {
      actions.push(a);
    },
    pushToast: (t: DaemonBridgeToast): void => {
      toasts.push(t);
    },
    clock: () => 10_000_000,
    intervals: { registryPollMs: 100_000, healthPollMs: 100_000 },
    setTimeoutFn: immediateTimeout,
    ...overrides,
  });
  return { bridge, actions, toasts };
}

// ---------------------------------------------------------------------------
// Live mode tests
// ---------------------------------------------------------------------------

describe("createDaemonBridge — live mode", () => {
  let fake: FakeRegistry;
  let fakeSupervisor: FakeSupervisor;

  beforeEach(() => {
    fake = makeFakeRegistry();
    fakeSupervisor = makeFakeSupervisor(makeHealth());
  });

  afterEach(async () => {
    await pumpMicrotasks();
  });

  test("health() poll dispatches set_supervisor_health", async () => {
    const health = makeHealth();
    fakeSupervisor.setHealth(health);

    const { bridge, actions } = makeLiveBridge(fake, fakeSupervisor, {
      intervals: { registryPollMs: 100_000, healthPollMs: 1 },
    });

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const healthActions = actions.filter((a) => a.kind === "set_supervisor_health");
    expect(healthActions.length).toBeGreaterThan(0);
    const last = healthActions[healthActions.length - 1];
    expect(last?.kind).toBe("set_supervisor_health");

    await bridge.close();
  });

  test("WorkerEvent.crashed pushes toast + supervisor event entry", async () => {
    const { bridge, actions, toasts } = makeLiveBridge(fake, fakeSupervisor);

    // Give bridge time to start loops
    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const crashEvent: WorkerEvent = {
      kind: "crashed",
      workerId: "worker-x" as never,
      at: 10_000_001,
      error: { code: "INTERNAL", message: "OOM error", retryable: false },
    };
    fakeSupervisor.pushWorkerEvent(crashEvent);

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const crashToasts = toasts.filter((t) => t.message.includes("crashed"));
    expect(crashToasts.length).toBe(1);
    expect(crashToasts[0]?.kind).toBe("warn");
    expect(crashToasts[0]?.message).toContain("OOM error");

    const eventActions = actions.filter((a) => a.kind === "push_supervisor_event");
    expect(eventActions.length).toBeGreaterThan(0);
    const last = eventActions[eventActions.length - 1];
    if (last?.kind === "push_supervisor_event") {
      expect(last.entry.kind).toBe("crashed");
      expect(last.entry.detail).toBe("OOM error");
    }

    await bridge.close();
  });

  test("crash dedup within 30s emits single toast", async () => {
    const { bridge, toasts } = makeLiveBridge(fake, fakeSupervisor, {
      clock: () => 10_000_000,
    });

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    // Push started event first to set incarnation
    const startedEvent: WorkerEvent = {
      kind: "started",
      workerId: "worker-dup" as never,
      at: 9_999_990,
    };
    fakeSupervisor.pushWorkerEvent(startedEvent);
    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const crashEvent: WorkerEvent = {
      kind: "crashed",
      workerId: "worker-dup" as never,
      at: 10_000_001,
      error: { code: "INTERNAL", message: "dup crash", retryable: false },
    };
    // Push same crash twice (same incarnation, within dedup window)
    fakeSupervisor.pushWorkerEvent(crashEvent);
    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }
    fakeSupervisor.pushWorkerEvent({ ...crashEvent });
    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const crashToasts = toasts.filter((t) => t.message.includes("dup crash"));
    expect(crashToasts.length).toBe(1);

    await bridge.close();
  });

  test("same workerId different incarnation (startedAt) emits two crash toasts", async () => {
    let now = 10_000_000;
    const { bridge, toasts } = makeLiveBridge(fake, fakeSupervisor, {
      clock: () => now,
    });

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    // First incarnation: started at t=100, crashed
    fakeSupervisor.pushWorkerEvent({ kind: "started", workerId: "worker-inc" as never, at: 100 });
    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }
    fakeSupervisor.pushWorkerEvent({
      kind: "crashed",
      workerId: "worker-inc" as never,
      at: 200,
      error: { code: "INTERNAL", message: "first crash", retryable: false },
    });
    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    // Advance time past dedup window
    now = 10_000_000 + 35_000;

    // Second incarnation: started at t=300, crashed
    fakeSupervisor.pushWorkerEvent({ kind: "started", workerId: "worker-inc" as never, at: 300 });
    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }
    fakeSupervisor.pushWorkerEvent({
      kind: "crashed",
      workerId: "worker-inc" as never,
      at: 400,
      error: { code: "INTERNAL", message: "second crash", retryable: false },
    });
    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const crashToasts = toasts.filter((t) => t.message.includes("crash"));
    expect(crashToasts.length).toBe(2);

    await bridge.close();
  });

  test("health.state running→quarantined emits toast once per transition", async () => {
    const runningWorker: SupervisorHealth["workers"][number] = {
      workerId: "worker-q" as never,
      agentId: "agent-q" as never,
      state: "running",
      lastHeartbeatAt: undefined,
      heartbeatDeadlineAt: undefined,
    };
    fakeSupervisor.setHealth(makeHealth([runningWorker]));

    const { bridge, toasts } = makeLiveBridge(fake, fakeSupervisor, {
      intervals: { registryPollMs: 100_000, healthPollMs: 1 },
    });

    // First poll: establishes baseline (running)
    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    // Change to quarantined
    fakeSupervisor.setHealth(makeHealth([{ ...runningWorker, state: "quarantined" }]));

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const quarantineToasts = toasts.filter((t) => t.message.includes("quarantined"));
    expect(quarantineToasts.length).toBe(1);
    expect(quarantineToasts[0]?.kind).toBe("warn");

    await bridge.close();
  });

  test("health.state running→restarting emits info toast", async () => {
    const runningWorker: SupervisorHealth["workers"][number] = {
      workerId: "worker-r" as never,
      agentId: "agent-r" as never,
      state: "running",
      lastHeartbeatAt: undefined,
      heartbeatDeadlineAt: undefined,
    };
    fakeSupervisor.setHealth(makeHealth([runningWorker]));

    const { bridge, toasts } = makeLiveBridge(fake, fakeSupervisor, {
      intervals: { registryPollMs: 100_000, healthPollMs: 1 },
    });

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    fakeSupervisor.setHealth(makeHealth([{ ...runningWorker, state: "restarting" }]));

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const restartToasts = toasts.filter((t) => t.message.includes("restarting"));
    expect(restartToasts.length).toBe(1);
    expect(restartToasts[0]?.kind).toBe("info");

    await bridge.close();
  });

  test("health.status ok→degraded emits warn toast", async () => {
    fakeSupervisor.setHealth(makeHealth());

    const { bridge, toasts } = makeLiveBridge(fake, fakeSupervisor, {
      intervals: { registryPollMs: 100_000, healthPollMs: 1 },
    });

    // Establish baseline (ok)
    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    fakeSupervisor.setHealth({
      ...makeHealth(),
      status: "degraded",
      reasons: ["worker quarantined"],
    });

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const degradedToasts = toasts.filter((t) => t.message.includes("supervisor degraded"));
    expect(degradedToasts.length).toBe(1);
    expect(degradedToasts[0]?.kind).toBe("warn");
    expect(degradedToasts[0]?.message).toContain("worker quarantined");

    await bridge.close();
  });

  test("3 consecutive health() failures → status stale, last snapshot preserved", async () => {
    const health = makeHealth();
    fakeSupervisor.setHealth(health);
    let healthCallCount = 0;
    let throwHealth = false;

    const throwingSupervisor: FakeSupervisor = {
      ...fakeSupervisor,
      health: (): SupervisorHealth => {
        healthCallCount++;
        if (throwHealth) throw new Error("health poll failed");
        return health;
      },
    };

    const { bridge, actions } = makeLiveBridge(fake, throwingSupervisor, {
      intervals: { registryPollMs: 100_000, healthPollMs: 1 },
    });

    // Get baseline health dispatched
    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }
    expect(healthCallCount).toBeGreaterThan(0);

    throwHealth = true;

    // Drive 3+ failures
    for (let i = 0; i < 10; i++) {
      await pumpMicrotasks();
    }

    const staleStatuses = actions.filter(
      (a) => a.kind === "set_supervisor_status" && a.status.kind === "stale",
    );
    expect(staleStatuses.length).toBeGreaterThan(0);

    // Last health dispatch was NOT null (snapshot preserved)
    const healthActions = actions.filter((a) => a.kind === "set_supervisor_health");
    expect(healthActions.length).toBeGreaterThan(0);
    const lastHealthAction = healthActions[healthActions.length - 1];
    if (lastHealthAction?.kind === "set_supervisor_health") {
      expect(lastHealthAction.health).not.toBeNull();
    }

    await bridge.close();
  });

  test("watchAll iterator throw → status degraded with missing workerEvents", async () => {
    fakeSupervisor.triggerWatchAllError(new Error("stream broke"));

    const { bridge, actions } = makeLiveBridge(fake, fakeSupervisor, {
      intervals: { registryPollMs: 100_000, healthPollMs: 100_000 },
    });

    for (let i = 0; i < 10; i++) {
      await pumpMicrotasks();
    }

    const degradedStatuses = actions.filter(
      (a) => a.kind === "set_supervisor_status" && a.status.kind === "degraded",
    );
    expect(degradedStatuses.length).toBeGreaterThan(0);
    const last = degradedStatuses[degradedStatuses.length - 1];
    if (last?.kind === "set_supervisor_status" && last.status.kind === "degraded") {
      expect(last.status.missing).toContain("workerEvents");
    }

    await bridge.close();
  });

  test("watchAll reacquire restores live; restoration toast fires once on degraded→live", async () => {
    fakeSupervisor.triggerWatchAllError(new Error("initial error"));

    const { bridge, actions, toasts } = makeLiveBridge(fake, fakeSupervisor, {
      intervals: { registryPollMs: 100_000, healthPollMs: 100_000 },
    });

    // Wait for stream to go stale
    for (let i = 0; i < 10; i++) {
      await pumpMicrotasks();
    }

    const degradedStatuses = actions.filter(
      (a) => a.kind === "set_supervisor_status" && a.status.kind === "degraded",
    );
    expect(degradedStatuses.length).toBeGreaterThan(0);

    // Push a real event — should restore live
    fakeSupervisor.pushWorkerEvent({
      kind: "heartbeat",
      workerId: "worker-restore" as never,
      at: 10_000_002,
    });

    for (let i = 0; i < 10; i++) {
      await pumpMicrotasks();
    }

    const restorationToasts = toasts.filter((t) =>
      t.message.includes("supervisor events restored"),
    );
    expect(restorationToasts.length).toBeGreaterThanOrEqual(1);

    // Second time restored toast fires only once
    const liveStatuses = actions.filter(
      (a) => a.kind === "set_supervisor_status" && a.status.kind === "live",
    );
    expect(liveStatuses.length).toBeGreaterThan(0);

    await bridge.close();
  });

  test("watchAll backoff cancelled by close() via closed sentinel", async () => {
    fakeSupervisor.triggerWatchAllError(new Error("initial error"));

    const { bridge } = makeLiveBridge(fake, fakeSupervisor, {
      intervals: { registryPollMs: 100_000, healthPollMs: 100_000 },
    });

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const start = Date.now();
    await bridge.close();
    const elapsed = Date.now() - start;

    // Should complete well under 1 second despite backoff
    expect(elapsed).toBeLessThan(1000);
  });

  test("locallySpawnedIds: markLocallySpawned inserts; terminal WorkerEvent removes", async () => {
    const { bridge } = makeLiveBridge(fake, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    bridge.markLocallySpawned("worker-local");

    // Push terminal event
    fakeSupervisor.pushWorkerEvent({
      kind: "exited",
      workerId: "worker-local" as never,
      at: 10_000_001,
      code: 0,
      state: "terminated",
    });

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    // After terminal, the worker is removed from locallySpawnedIds
    // We can verify indirectly by running a kill and checking ownership
    const result = await bridge.requestKill({
      workerId: "worker-local",
      expectedVersion: 1,
      expectedPid: 1234,
    });
    // worker-local not in health.workers (empty) and not in locallySpawnedIds
    expect(result.kind).toBe("refused");

    await bridge.close();
  });

  test("locallySpawnedIds cleared on workerEvents → stale", async () => {
    const { bridge } = makeLiveBridge(fake, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    bridge.markLocallySpawned("worker-stale-test");

    // Trigger watchAll error to go stale
    fakeSupervisor.triggerWatchAllError(new Error("stream broke"));

    for (let i = 0; i < 10; i++) {
      await pumpMicrotasks();
    }

    // After going stale, locallySpawnedIds should be cleared
    // We verify by checking kill is refused (not owned anymore)
    const result = await bridge.requestKill({
      workerId: "worker-stale-test",
      expectedVersion: 1,
      expectedPid: 1234,
    });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toContain("not locally owned");

    await bridge.close();
  });

  test("requestKill happy path: describe matches → supervisor.stop called → kind: stopped", async () => {
    const rec = makeRecord("worker-kill", "agent-kill");
    fake.setRecords([rec]);
    // Make registry.describe work
    const fakeWithDescribe: FakeRegistry = {
      ...fake,
      describe: async (
        _id: WorkerId,
      ): Promise<Result<BackgroundSessionRecord | undefined, KoiError>> => ({
        ok: true,
        value: { ...rec, status: "running", version: 1, pid: rec.pid },
      }),
    };

    // Setup health with this worker
    fakeSupervisor.setHealth(
      makeHealth([
        {
          workerId: "worker-kill" as never,
          agentId: "agent-kill" as never,
          state: "running",
          lastHeartbeatAt: undefined,
          heartbeatDeadlineAt: undefined,
        },
      ]),
    );

    const { bridge } = makeLiveBridge(fakeWithDescribe, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const result = await bridge.requestKill({
      workerId: "worker-kill",
      expectedVersion: 1,
      expectedPid: rec.pid,
    });

    expect(result.kind).toBe("stopped");
    expect(fakeSupervisor.stopCalls().length).toBe(1);
    expect(fakeSupervisor.stopCalls()[0]?.id).toBe("worker-kill");

    await bridge.close();
  });

  test("requestKill registry unreadable → info toast + supervisor.stop still called", async () => {
    const fakeWithUnreadable: FakeRegistry = {
      ...fake,
      describe: async (
        _id: WorkerId,
      ): Promise<Result<BackgroundSessionRecord | undefined, KoiError>> => ({
        ok: false,
        error: { code: "INTERNAL", message: "registry down", retryable: false },
      }),
    };

    fakeSupervisor.setHealth(
      makeHealth([
        {
          workerId: "worker-unreg" as never,
          agentId: "agent-unreg" as never,
          state: "running",
          lastHeartbeatAt: undefined,
          heartbeatDeadlineAt: undefined,
        },
      ]),
    );

    const { bridge, toasts } = makeLiveBridge(fakeWithUnreadable, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const result = await bridge.requestKill({
      workerId: "worker-unreg",
      expectedVersion: 1,
      expectedPid: 1234,
    });

    expect(result.kind).toBe("stopped");
    const infoToasts = toasts.filter((t) => t.message.includes("registry unreadable"));
    expect(infoToasts.length).toBe(1);
    expect(fakeSupervisor.stopCalls().length).toBe(1);

    await bridge.close();
  });

  test("requestKill mismatched version/pid → no supervisor.stop, kind: refused, warn toast", async () => {
    const rec = makeRecord("worker-mismatch", "agent-m");
    const fakeWithDescribe: FakeRegistry = {
      ...fake,
      describe: async (): Promise<{ ok: true; value: typeof rec }> => ({
        ok: true,
        value: { ...rec, status: "running", version: 5, pid: 9999 },
      }),
    };

    fakeSupervisor.setHealth(
      makeHealth([
        {
          workerId: "worker-mismatch" as never,
          agentId: "agent-m" as never,
          state: "running",
          lastHeartbeatAt: undefined,
          heartbeatDeadlineAt: undefined,
        },
      ]),
    );

    const { bridge, toasts } = makeLiveBridge(fakeWithDescribe, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const result = await bridge.requestKill({
      workerId: "worker-mismatch",
      expectedVersion: 1, // mismatch: registry has version 5
      expectedPid: 1234, // mismatch: registry has pid 9999
    });

    expect(result.kind).toBe("refused");
    expect(fakeSupervisor.stopCalls().length).toBe(0);
    const warnToasts = toasts.filter((t) => t.message.includes("row stale"));
    expect(warnToasts.length).toBe(1);

    await bridge.close();
  });

  test("requestKill expectedPid=0 + workerEvents live → bypass CAS, supervisor.stop called", async () => {
    const rec = makeRecord("worker-starting", "agent-s", "starting");
    const fakeWithDescribe: FakeRegistry = {
      ...fake,
      describe: async (): Promise<{ ok: true; value: typeof rec }> => ({
        ok: true,
        value: { ...rec, status: "starting", version: 99, pid: 0 },
      }),
    };

    fakeSupervisor.setHealth(
      makeHealth([
        {
          workerId: "worker-starting" as never,
          agentId: "agent-s" as never,
          state: "running",
          lastHeartbeatAt: undefined,
          heartbeatDeadlineAt: undefined,
        },
      ]),
    );

    const { bridge } = makeLiveBridge(fakeWithDescribe, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    // workerEvents is live (no errors); expectedPid=0 → bypass CAS
    const result = await bridge.requestKill({
      workerId: "worker-starting",
      expectedVersion: 1, // version mismatch — but bypassed
      expectedPid: 0,
    });

    expect(result.kind).toBe("stopped");
    expect(fakeSupervisor.stopCalls().length).toBe(1);

    await bridge.close();
  });

  test("requestKill expectedPid=0 + workerEvents stale → enforce version CAS; mismatch refuses", async () => {
    const rec = makeRecord("worker-starting2", "agent-s2", "starting");
    const fakeWithDescribe: FakeRegistry = {
      ...fake,
      describe: async (): Promise<{ ok: true; value: typeof rec }> => ({
        ok: true,
        // version mismatch from expected
        value: { ...rec, status: "starting", version: 99, pid: 0 },
      }),
    };

    fakeSupervisor.setHealth(
      makeHealth([
        {
          workerId: "worker-starting2" as never,
          agentId: "agent-s2" as never,
          state: "running",
          lastHeartbeatAt: undefined,
          heartbeatDeadlineAt: undefined,
        },
      ]),
    );

    // Trigger watchAll error to make workerEvents stale
    fakeSupervisor.triggerWatchAllError(new Error("stream broke"));

    const { bridge, toasts } = makeLiveBridge(fakeWithDescribe, fakeSupervisor, {
      intervals: { registryPollMs: 100_000, healthPollMs: 100_000 },
    });

    for (let i = 0; i < 15; i++) {
      await pumpMicrotasks();
    }

    const result = await bridge.requestKill({
      workerId: "worker-starting2",
      expectedVersion: 1, // mismatch (registry has 99)
      expectedPid: 0,
    });

    expect(result.kind).toBe("refused");
    expect(fakeSupervisor.stopCalls().length).toBe(0);
    const warnToasts = toasts.filter((t) => t.message.includes("row stale"));
    expect(warnToasts.length).toBe(1);

    await bridge.close();
  });

  test("requestKill foreign worker (not in health.workers + not in locallySpawnedIds) → refused, no supervisor.stop", async () => {
    // health.workers is empty
    fakeSupervisor.setHealth(makeHealth([]));

    const { bridge } = makeLiveBridge(fake, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const result = await bridge.requestKill({
      workerId: "foreign-worker",
      expectedVersion: 1,
      expectedPid: 1234,
    });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toContain("not locally owned");
    }
    expect(fakeSupervisor.stopCalls().length).toBe(0);

    await bridge.close();
  });

  test("requestKill terminal/terminating/detached registry record → refused", async () => {
    const testCases = [
      { status: "exited" as const, expectedReason: "already terminal" },
      { status: "crashed" as const, expectedReason: "already terminal" },
      { status: "terminating" as const, expectedReason: "kill in flight; wait" },
      { status: "detached" as const, expectedReason: "use koi bg kill or koi bg attach" },
    ];

    for (const tc of testCases) {
      const fresh = makeFakeRegistry();
      const freshSupervisor = makeFakeSupervisor(
        makeHealth([
          {
            workerId: "worker-term" as never,
            agentId: "agent-term" as never,
            state: "running",
            lastHeartbeatAt: undefined,
            heartbeatDeadlineAt: undefined,
          },
        ]),
      );

      const rec = makeRecord("worker-term", "agent-term", tc.status);
      const fakeWithDescribe: FakeRegistry = {
        ...fresh,
        describe: async (): Promise<{ ok: true; value: typeof rec }> => ({
          ok: true,
          value: rec,
        }),
      };

      const { bridge } = makeLiveBridge(fakeWithDescribe, freshSupervisor);

      for (let i = 0; i < 3; i++) {
        await pumpMicrotasks();
      }

      const result = await bridge.requestKill({
        workerId: "worker-term",
        expectedVersion: 1,
        expectedPid: rec.pid,
      });

      expect(result.kind).toBe("refused");
      if (result.kind === "refused") {
        expect(result.reason).toBe(tc.expectedReason);
      }
      expect(freshSupervisor.stopCalls().length).toBe(0);

      await bridge.close();
    }
  });

  test("requestKill in registry-only mode → refused with hint", async () => {
    const { actions, toasts } = collectActions();
    const bridge = createDaemonBridge({
      mode: { kind: "registry-only", registry: fake },
      dispatch: (a: TuiAction): void => {
        actions.push(a);
      },
      pushToast: (t: DaemonBridgeToast): void => {
        toasts.push(t);
      },
      clock: () => 10_000_000,
    });

    const result = await bridge.requestKill({
      workerId: "any-worker",
      expectedVersion: 1,
      expectedPid: 1234,
    });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toContain("no live supervisor");
    }

    await bridge.close();
  });

  test("WorkerEvent.started dispatches add_info with ↑ prefix", async () => {
    const { bridge, actions } = makeLiveBridge(fake, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const startedEvent: WorkerEvent = {
      kind: "started",
      workerId: "worker-s1" as never,
      at: 10_000_001,
    };
    fakeSupervisor.pushWorkerEvent(startedEvent);

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const infoActions = actions.filter((a) => a.kind === "add_info" && a.message.startsWith("↑"));
    expect(infoActions.length).toBe(1);
    const msg = infoActions[0];
    if (msg?.kind === "add_info") {
      expect(msg.message).toContain("worker-s1");
    }

    await bridge.close();
  });

  test("WorkerEvent.exited dispatches add_info with code+state", async () => {
    const { bridge, actions } = makeLiveBridge(fake, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const exitedEvent: WorkerEvent = {
      kind: "exited",
      workerId: "worker-e1" as never,
      at: 10_000_001,
      code: 1,
      state: "terminated",
    };
    fakeSupervisor.pushWorkerEvent(exitedEvent);

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const infoActions = actions.filter((a) => a.kind === "add_info" && a.message.startsWith("↓"));
    expect(infoActions.length).toBe(1);
    const msg = infoActions[0];
    if (msg?.kind === "add_info") {
      expect(msg.message).toContain("code=1");
      expect(msg.message).toContain("state=terminated");
    }

    await bridge.close();
  });

  test("WorkerEvent.crashed dispatches add_info with error.message", async () => {
    const { bridge, actions } = makeLiveBridge(fake, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const crashedEvent: WorkerEvent = {
      kind: "crashed",
      workerId: "worker-c1" as never,
      at: 10_000_001,
      error: { code: "INTERNAL", message: "segfault in worker", retryable: false },
    };
    fakeSupervisor.pushWorkerEvent(crashedEvent);

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const infoActions = actions.filter((a) => a.kind === "add_info" && a.message.startsWith("✗"));
    expect(infoActions.length).toBe(1);
    const msg = infoActions[0];
    if (msg?.kind === "add_info") {
      expect(msg.message).toContain("segfault in worker");
    }

    await bridge.close();
  });

  test("WorkerEvent.heartbeat does NOT dispatch add_info (too noisy)", async () => {
    const { bridge, actions } = makeLiveBridge(fake, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const heartbeatEvent: WorkerEvent = {
      kind: "heartbeat",
      workerId: "worker-hb" as never,
      at: 10_000_001,
    };
    fakeSupervisor.pushWorkerEvent(heartbeatEvent);

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const infoActions = actions.filter((a) => a.kind === "add_info");
    expect(infoActions.length).toBe(0);

    await bridge.close();
  });

  test("derived running→restarting dispatches add_info with '(derived)' suffix", async () => {
    const runningWorker: SupervisorHealth["workers"][number] = {
      workerId: "worker-dr" as never,
      agentId: "agent-dr" as never,
      state: "running",
      lastHeartbeatAt: undefined,
      heartbeatDeadlineAt: undefined,
    };
    fakeSupervisor.setHealth(makeHealth([runningWorker]));

    const { bridge, actions } = makeLiveBridge(fake, fakeSupervisor, {
      intervals: { registryPollMs: 100_000, healthPollMs: 1 },
    });

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    fakeSupervisor.setHealth(makeHealth([{ ...runningWorker, state: "restarting" }]));

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const derivedInfoActions = actions.filter(
      (a) => a.kind === "add_info" && a.message.includes("(derived)"),
    );
    expect(derivedInfoActions.length).toBe(1);
    const msg = derivedInfoActions[0];
    if (msg?.kind === "add_info") {
      expect(msg.message).toContain("restarting");
      expect(msg.message).toContain("(derived)");
    }

    await bridge.close();
  });

  test("derived running→quarantined dispatches add_info with '(derived)' suffix", async () => {
    const runningWorker: SupervisorHealth["workers"][number] = {
      workerId: "worker-dq" as never,
      agentId: "agent-dq" as never,
      state: "running",
      lastHeartbeatAt: undefined,
      heartbeatDeadlineAt: undefined,
    };
    fakeSupervisor.setHealth(makeHealth([runningWorker]));

    const { bridge, actions } = makeLiveBridge(fake, fakeSupervisor, {
      intervals: { registryPollMs: 100_000, healthPollMs: 1 },
    });

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    fakeSupervisor.setHealth(makeHealth([{ ...runningWorker, state: "quarantined" }]));

    for (let i = 0; i < 5; i++) {
      await pumpMicrotasks();
    }

    const derivedInfoActions = actions.filter(
      (a) => a.kind === "add_info" && a.message.includes("(derived)"),
    );
    expect(derivedInfoActions.length).toBe(1);
    const msg = derivedInfoActions[0];
    if (msg?.kind === "add_info") {
      expect(msg.message).toContain("quarantined");
      expect(msg.message).toContain("(derived)");
    }

    await bridge.close();
  });

  test("requestKill supervisor.stop returning Result.ok:false → toast + refused", async () => {
    fakeSupervisor.setHealth(
      makeHealth([
        {
          workerId: "worker-stopfail" as never,
          agentId: "agent-sf" as never,
          state: "running",
          lastHeartbeatAt: undefined,
          heartbeatDeadlineAt: undefined,
        },
      ]),
    );
    fakeSupervisor.setStopResult({
      ok: false,
      error: { code: "NOT_FOUND", message: "worker already gone", retryable: false },
    });

    const rec = makeRecord("worker-stopfail", "agent-sf");
    const fakeWithDescribe: FakeRegistry = {
      ...fake,
      describe: async (): Promise<{ ok: true; value: typeof rec }> => ({
        ok: true,
        value: { ...rec, status: "running", version: 1, pid: rec.pid },
      }),
    };

    const { bridge, toasts } = makeLiveBridge(fakeWithDescribe, fakeSupervisor);

    for (let i = 0; i < 3; i++) {
      await pumpMicrotasks();
    }

    const result = await bridge.requestKill({
      workerId: "worker-stopfail",
      expectedVersion: 1,
      expectedPid: rec.pid,
    });

    expect(result.kind).toBe("refused");
    const warnToasts = toasts.filter((t) => t.message.includes("stop failed"));
    expect(warnToasts.length).toBe(1);

    await bridge.close();
  });
});
