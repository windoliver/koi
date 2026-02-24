/**
 * Tests for createDeliveryManager — retry lifecycle for pending frames.
 */

import { describe, expect, mock, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { agentId, sessionId } from "@koi/core";
import type { DeliveryManagerDeps } from "./delivery-manager.js";
import { createDeliveryManager } from "./delivery-manager.js";
import type { NodeEvent, NodeFrame, NodePendingFrame, NodeSessionStore } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePendingFrame(overrides: Partial<NodePendingFrame> = {}): NodePendingFrame {
  return {
    frameId: "f1",
    sessionId: sessionId("s1"),
    agentId: agentId("agent-1"),
    frameType: "agent:message",
    payload: { text: "hello" },
    orderIndex: 0,
    createdAt: Date.now(),
    retryCount: 0,
    ...overrides,
  };
}

function ok(): Result<void, KoiError> {
  return { ok: true, value: undefined };
}

function createMockStore(frames: readonly NodePendingFrame[] = []): NodeSessionStore {
  const storedFrames = [...frames];

  return {
    saveSession: mock(() => ok()),
    removeSession: mock(() => ok()),
    saveCheckpoint: mock(() => ok()),
    loadLatestCheckpoint: mock(() => ({ ok: true as const, value: undefined })),
    savePendingFrame: mock((frame: NodePendingFrame) => {
      const idx = storedFrames.findIndex((f) => f.frameId === frame.frameId);
      if (idx >= 0) {
        storedFrames[idx] = frame;
      } else {
        storedFrames.push(frame);
      }
      return ok();
    }),
    loadPendingFrames: mock(() => ({
      ok: true as const,
      value: [...storedFrames],
    })),
    clearPendingFrames: mock(() => ok()),
    removePendingFrame: mock((frameId: string) => {
      const idx = storedFrames.findIndex((f) => f.frameId === frameId);
      if (idx >= 0) storedFrames.splice(idx, 1);
      return ok();
    }),
    recover: mock(() => ({
      ok: true as const,
      value: { sessions: [], checkpoints: new Map(), pendingFrames: new Map(), skipped: [] },
    })),
    close: mock(() => {}),
  };
}

function createMockDeps(
  frames: readonly NodePendingFrame[] = [],
  connected = true,
): {
  readonly deps: DeliveryManagerDeps;
  readonly events: NodeEvent[];
  readonly store: NodeSessionStore;
} {
  const store = createMockStore(frames);
  const events: NodeEvent[] = [];

  const deps: DeliveryManagerDeps = {
    store,
    isConnected: () => connected,
    sendFrame: mock(() => {}),
    emit: mock((type: NodeEvent["type"], data?: unknown) => {
      events.push({ type, timestamp: Date.now(), data });
    }),
  };

  return { deps, events, store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeliveryManager", () => {
  test("sends frame when transport is connected", async () => {
    const frame = makePendingFrame({ frameId: "f1" });
    const { deps, events } = createMockDeps([frame], true);

    const dm = createDeliveryManager(deps);
    await dm.replayPendingFrames("s1");
    dm.dispose();

    expect(deps.sendFrame).toHaveBeenCalledTimes(1);
    expect(deps.store.removePendingFrame).toHaveBeenCalledWith("f1");
    expect(events.some((e) => e.type === "pending_frame_sent")).toBe(true);
  });

  test("skips expired frames and emits event", async () => {
    const frame = makePendingFrame({
      frameId: "f-expired",
      createdAt: Date.now() - 10_000,
      ttl: 5_000,
    });
    const { deps, events } = createMockDeps([frame], true);

    const dm = createDeliveryManager(deps);
    await dm.replayPendingFrames("s1");
    dm.dispose();

    expect(deps.sendFrame).toHaveBeenCalledTimes(0);
    expect(deps.store.removePendingFrame).toHaveBeenCalledWith("f-expired");
    expect(events.some((e) => e.type === "pending_frame_expired")).toBe(true);
  });

  test("dead-letters frames exceeding max retries", async () => {
    const frame = makePendingFrame({ frameId: "f-dead", retryCount: 5 });
    const { deps, events } = createMockDeps([frame], true);

    const dm = createDeliveryManager(deps, { maxRetries: 5 });
    await dm.replayPendingFrames("s1");
    dm.dispose();

    expect(deps.sendFrame).toHaveBeenCalledTimes(0);
    expect(deps.store.removePendingFrame).toHaveBeenCalledWith("f-dead");
    expect(events.some((e) => e.type === "pending_frame_dead_letter")).toBe(true);
  });

  test("increments retryCount and schedules retry when disconnected", async () => {
    const frame = makePendingFrame({ frameId: "f-retry", retryCount: 0 });
    const { deps, store } = createMockDeps([frame], false);

    const dm = createDeliveryManager(deps, {
      maxRetries: 5,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      multiplier: 2,
      jitter: 0,
    });
    await dm.replayPendingFrames("s1");

    // Should have saved with incremented retryCount
    expect(store.savePendingFrame).toHaveBeenCalled();
    const savedCall = (store.savePendingFrame as ReturnType<typeof mock>).mock.calls[0];
    const savedFrame = savedCall?.[0] as NodePendingFrame | undefined;
    expect(savedFrame?.retryCount).toBe(1);

    // Should NOT have sent (transport disconnected)
    expect(deps.sendFrame).toHaveBeenCalledTimes(0);

    dm.dispose();
  });

  test("dispose clears all pending timers", async () => {
    const frames = [
      makePendingFrame({ frameId: "f1", retryCount: 0, orderIndex: 0 }),
      makePendingFrame({ frameId: "f2", retryCount: 1, orderIndex: 1 }),
    ];
    const { deps } = createMockDeps(frames, false);

    const dm = createDeliveryManager(deps, {
      maxRetries: 10,
      baseDelayMs: 60_000,
      maxDelayMs: 120_000,
      multiplier: 2,
      jitter: 0,
    });
    await dm.replayPendingFrames("s1");

    // Timers are scheduled — dispose should clear them
    dm.dispose();

    // Wait a tick to verify timers don't fire after dispose
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deps.sendFrame).toHaveBeenCalledTimes(0);
  });

  test("handles empty pending frame list", async () => {
    const { deps } = createMockDeps([], true);

    const dm = createDeliveryManager(deps);
    await dm.replayPendingFrames("s1");
    dm.dispose();

    expect(deps.sendFrame).toHaveBeenCalledTimes(0);
    expect(deps.emit).toHaveBeenCalledTimes(0);
  });

  test("stops processing when maxRecoveryMs budget is exceeded", async () => {
    const frames = Array.from({ length: 5 }, (_, i) =>
      makePendingFrame({ frameId: `f-budget-${i}`, orderIndex: i }),
    );
    const { deps } = createMockDeps(frames, true);

    // Simulate slow sends: each sendFrame burns 30ms
    let sendCount = 0;
    (deps as { sendFrame: (frame: NodePendingFrame) => void }).sendFrame = () => {
      sendCount++;
      const start = Date.now();
      // Busy-wait to simulate work (bun:test doesn't support fake timers for Date.now)
      while (Date.now() - start < 30) {
        /* spin */
      }
    };

    const dm = createDeliveryManager(deps, { maxRecoveryMs: 50 });
    await dm.replayPendingFrames("s1");
    dm.dispose();

    // Should have processed some frames but not all 5
    expect(sendCount).toBeGreaterThan(0);
    expect(sendCount).toBeLessThan(5);
  });

  test("processes all frames when maxRecoveryMs is 0 (no limit)", async () => {
    const frames = Array.from({ length: 5 }, (_, i) =>
      makePendingFrame({ frameId: `f-nolimit-${i}`, orderIndex: i }),
    );
    const { deps } = createMockDeps(frames, true);

    const dm = createDeliveryManager(deps, { maxRecoveryMs: 0 });
    await dm.replayPendingFrames("s1");
    dm.dispose();

    expect(deps.sendFrame).toHaveBeenCalledTimes(5);
  });

  test("handles load failure gracefully", async () => {
    const store = createMockStore();
    (store.loadPendingFrames as ReturnType<typeof mock>).mockImplementation(() => ({
      ok: false as const,
      error: { code: "INTERNAL", message: "db error", retryable: false },
    }));
    const events: NodeEvent[] = [];
    const deps: DeliveryManagerDeps = {
      store,
      isConnected: () => true,
      sendFrame: mock(() => {}),
      emit: mock((type: NodeEvent["type"], data?: unknown) => {
        events.push({ type, timestamp: Date.now(), data });
      }),
    };

    const dm = createDeliveryManager(deps);
    await dm.replayPendingFrames("s1");
    dm.dispose();

    // Should not crash, should not send
    expect(deps.sendFrame).toHaveBeenCalledTimes(0);
  });

  test("does not expire frames without ttl", async () => {
    const frame = makePendingFrame({
      frameId: "f-no-ttl",
      createdAt: Date.now() - 100_000,
      ttl: undefined,
    });
    const { deps, events } = createMockDeps([frame], true);

    const dm = createDeliveryManager(deps);
    await dm.replayPendingFrames("s1");
    dm.dispose();

    expect(deps.sendFrame).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "pending_frame_sent")).toBe(true);
    expect(events.some((e) => e.type === "pending_frame_expired")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enqueueSend tests
// ---------------------------------------------------------------------------

function makeNodeFrame(overrides: Partial<NodeFrame> = {}): NodeFrame {
  return {
    nodeId: "node-1",
    agentId: "agent-1",
    correlationId: "corr-1",
    kind: "agent:message",
    payload: { text: "hello" },
    ...overrides,
  };
}

describe("DeliveryManager.enqueueSend", () => {
  test("persists frame and sends when connected", async () => {
    const { deps, events, store } = createMockDeps([], true);

    const dm = createDeliveryManager(deps);
    await dm.enqueueSend(makeNodeFrame(), "s1");
    dm.dispose();

    // Should have persisted
    expect(store.savePendingFrame).toHaveBeenCalledTimes(1);
    // Should have sent (connected)
    expect(deps.sendFrame).toHaveBeenCalledTimes(1);
    // Should have removed after successful send
    expect(store.removePendingFrame).toHaveBeenCalledWith("pf-corr-1");
    // Should emit pending_frame_sent
    expect(events.some((e) => e.type === "pending_frame_sent")).toBe(true);
  });

  test("persists but does not send when disconnected", async () => {
    const { deps, events, store } = createMockDeps([], false);

    const dm = createDeliveryManager(deps);
    await dm.enqueueSend(makeNodeFrame(), "s1");
    dm.dispose();

    // Should have persisted
    expect(store.savePendingFrame).toHaveBeenCalledTimes(1);
    // Should NOT have sent (disconnected)
    expect(deps.sendFrame).toHaveBeenCalledTimes(0);
    // Should NOT have removed (awaiting reconnect replay)
    expect(store.removePendingFrame).toHaveBeenCalledTimes(0);
    // No sent event
    expect(events.some((e) => e.type === "pending_frame_sent")).toBe(false);
  });

  test("removes frame from store after successful send", async () => {
    const { deps, store } = createMockDeps([], true);

    const dm = createDeliveryManager(deps);
    await dm.enqueueSend(makeNodeFrame({ correlationId: "c-42" }), "s1");
    dm.dispose();

    expect(store.removePendingFrame).toHaveBeenCalledWith("pf-c-42");
  });

  test("falls back to direct send on store failure", async () => {
    const store = createMockStore();
    (store.savePendingFrame as ReturnType<typeof mock>).mockImplementation(() => ({
      ok: false as const,
      error: { code: "INTERNAL", message: "disk full", retryable: false },
    }));
    const events: NodeEvent[] = [];
    const deps: DeliveryManagerDeps = {
      store,
      isConnected: () => true,
      sendFrame: mock(() => {}),
      emit: mock((type: NodeEvent["type"], data?: unknown) => {
        events.push({ type, timestamp: Date.now(), data });
      }),
    };

    const dm = createDeliveryManager(deps);
    await dm.enqueueSend(makeNodeFrame(), "s1");
    dm.dispose();

    // Should have fallen back to direct send
    expect(deps.sendFrame).toHaveBeenCalledTimes(1);
    // No remove call (frame wasn't in store)
    expect(store.removePendingFrame).toHaveBeenCalledTimes(0);
  });

  test("derives frameId from correlationId", async () => {
    const { deps, store } = createMockDeps([], true);

    const dm = createDeliveryManager(deps);
    await dm.enqueueSend(makeNodeFrame({ correlationId: "abc-123" }), "s1");
    dm.dispose();

    const savedFrame = (store.savePendingFrame as ReturnType<typeof mock>).mock.calls[0]?.[0] as
      | NodePendingFrame
      | undefined;
    expect(savedFrame?.frameId).toBe("pf-abc-123");
  });

  test("preserves ttl from source frame", async () => {
    const { deps, store } = createMockDeps([], true);

    const dm = createDeliveryManager(deps);
    await dm.enqueueSend(makeNodeFrame({ ttl: 30_000 }), "s1");
    dm.dispose();

    const savedFrame = (store.savePendingFrame as ReturnType<typeof mock>).mock.calls[0]?.[0] as
      | NodePendingFrame
      | undefined;
    expect(savedFrame?.ttl).toBe(30_000);
  });
});
