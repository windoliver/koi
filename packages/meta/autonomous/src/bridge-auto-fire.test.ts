/**
 * Unit tests for createBridgeAutoFire.
 */

import { describe, expect, mock, test } from "bun:test";
import type { HarnessScheduler, HarnessSchedulerStatus } from "@koi/harness-scheduler";
import { createBridgeAutoFire } from "./bridge-auto-fire.js";
import type { HarnessHandoffBridge } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBridge(opts?: { readonly fired?: boolean }): HarnessHandoffBridge {
  // let justified: mutable mock state for hasFired
  let fired = opts?.fired ?? false;
  return {
    onHarnessCompleted: mock(async () => {
      fired = true;
      return { ok: true as const, value: "handoff-1" as never };
    }),
    hasFired: () => fired,
  };
}

function createMockScheduler(initialPhase: HarnessSchedulerStatus["phase"]): {
  readonly scheduler: HarnessScheduler;
  readonly setPhase: (p: HarnessSchedulerStatus["phase"]) => void;
} {
  // let justified: mutable phase for testing
  let phase = initialPhase;
  const scheduler: HarnessScheduler = {
    start: () => {},
    stop: () => {},
    status: () => ({
      phase,
      retriesRemaining: 3,
      totalResumes: 0,
    }),
    dispose: async () => {},
  };
  return {
    scheduler,
    setPhase: (p) => {
      phase = p;
    },
  };
}

function immediateDelay(): Promise<void> {
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createBridgeAutoFire", () => {
  test("fires bridge when scheduler phase reaches stopped", async () => {
    const { scheduler } = createMockScheduler("stopped");
    const bridge = createMockBridge();

    const handle = createBridgeAutoFire({
      scheduler,
      bridge,
      delay: immediateDelay,
    });

    await handle.done;
    expect(bridge.onHarnessCompleted).toHaveBeenCalledTimes(1);
  });

  test("does not fire when scheduler phase reaches failed", async () => {
    const { scheduler } = createMockScheduler("failed");
    const bridge = createMockBridge();

    const handle = createBridgeAutoFire({
      scheduler,
      bridge,
      delay: immediateDelay,
    });

    await handle.done;
    expect(bridge.onHarnessCompleted).not.toHaveBeenCalled();
  });

  test("cancel prevents bridge from firing", async () => {
    const { scheduler, setPhase } = createMockScheduler("running");
    const bridge = createMockBridge();

    // let justified: track poll count to cancel after first poll
    let pollCount = 0;

    const handle = createBridgeAutoFire({
      scheduler,
      bridge,
      delay: async () => {
        pollCount += 1;
        if (pollCount >= 2) {
          handle.cancel();
          // Transition to stopped after cancel — should not fire
          setPhase("stopped");
        }
      },
    });

    await handle.done;
    expect(bridge.onHarnessCompleted).not.toHaveBeenCalled();
  });

  test("hasFired() prevents double-fire", async () => {
    const { scheduler } = createMockScheduler("stopped");
    const bridge = createMockBridge({ fired: true });

    const handle = createBridgeAutoFire({
      scheduler,
      bridge,
      delay: immediateDelay,
    });

    await handle.done;
    expect(bridge.onHarnessCompleted).not.toHaveBeenCalled();
  });

  test("onError callback receives unexpected errors", async () => {
    const { scheduler } = createMockScheduler("stopped");
    const bridge: HarnessHandoffBridge = {
      onHarnessCompleted: mock(async () => {
        throw new Error("boom");
      }),
      hasFired: () => false,
    };
    const onError = mock((_e: unknown) => {});

    const handle = createBridgeAutoFire({
      scheduler,
      bridge,
      delay: immediateDelay,
      onError,
    });

    await handle.done;
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom");
  });

  test("done resolves after bridge fires", async () => {
    const { scheduler } = createMockScheduler("stopped");
    const bridge = createMockBridge();

    const handle = createBridgeAutoFire({
      scheduler,
      bridge,
      delay: immediateDelay,
    });

    await handle.done;
    // If we get here, done resolved
    expect(bridge.hasFired()).toBe(true);
  });

  test("done resolves after cancel", async () => {
    const { scheduler } = createMockScheduler("running");
    const bridge = createMockBridge();

    // let justified: deferred handle reference to avoid "before initialization" error
    let handleRef: { cancel: () => void } | undefined;

    const handle = createBridgeAutoFire({
      scheduler,
      bridge,
      delay: async () => {
        handleRef?.cancel();
      },
    });

    handleRef = handle;

    await handle.done;
    expect(bridge.onHarnessCompleted).not.toHaveBeenCalled();
  });

  test("polls until scheduler reaches stopped", async () => {
    const { scheduler, setPhase } = createMockScheduler("running");
    const bridge = createMockBridge();

    // let justified: track poll count to transition after 3 polls
    let pollCount = 0;

    const handle = createBridgeAutoFire({
      scheduler,
      bridge,
      delay: async () => {
        pollCount += 1;
        if (pollCount >= 3) {
          setPhase("stopped");
        }
      },
    });

    await handle.done;
    expect(pollCount).toBeGreaterThanOrEqual(3);
    expect(bridge.onHarnessCompleted).toHaveBeenCalledTimes(1);
  });
});
