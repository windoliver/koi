/**
 * Tests for createDeliveryManager — retry lifecycle for pending frames.
 */

import { describe, expect, mock, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { agentId } from "@koi/core";
import type { DeliveryManagerDeps } from "./delivery-manager.js";
import { createDeliveryManager } from "./delivery-manager.js";
import type { NodeEvent, NodePendingFrame, NodeSessionStore } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePendingFrame(overrides: Partial<NodePendingFrame> = {}): NodePendingFrame {
  return {
    frameId: "f1",
    sessionId: "s1",
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
      value: { sessions: [], checkpoints: new Map(), pendingFrames: new Map() },
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
