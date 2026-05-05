/**
 * Tests for createDaemonBridge — registry-only mode.
 *
 * Uses a fake registry built in-process. Timer injection (setTimeoutFn) is
 * used instead of bun fake-timer APIs so we can drive the poll loop
 * deterministically without depending on global timer state.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackgroundSessionEvent } from "@koi/core/daemon";
import type { KoiError } from "@koi/core/errors";
import type { TuiAction } from "@koi/tui";
import {
  type CreateDaemonBridgeOptions,
  createDaemonBridge,
  type DaemonBridgeToast,
} from "./daemon-bridge.js";
import type { FakeRegistry } from "./daemon-bridge.test-helpers.js";
import { makeFakeRegistry, makeRecord } from "./daemon-bridge.test-helpers.js";

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
});
