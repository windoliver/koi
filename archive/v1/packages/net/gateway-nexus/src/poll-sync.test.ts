import { afterEach, describe, expect, test } from "bun:test";
import { createDegradationState, recordFailure } from "./degradation.js";
import type { PollSyncHandle } from "./poll-sync.js";
import { createPollSync } from "./poll-sync.js";

describe("PollSync", () => {
  let handle: PollSyncHandle | undefined;

  afterEach(() => {
    handle?.dispose();
    handle = undefined;
  });

  test("polls at configured interval", async () => {
    let pollCount = 0;
    let state = createDegradationState();
    handle = createPollSync(
      { intervalMs: 30 },
      async () => {
        pollCount++;
        return { ok: true };
      },
      () => state,
      (s) => {
        state = s;
      },
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  test("manual poll triggers immediately", async () => {
    let polled = false;
    let state = createDegradationState();
    handle = createPollSync(
      { intervalMs: 60_000 },
      async () => {
        polled = true;
        return { ok: true };
      },
      () => state,
      (s) => {
        state = s;
      },
    );
    await handle.poll();
    expect(polled).toBe(true);
  });

  test("successful poll transitions to healthy", async () => {
    let state = createDegradationState();
    // Force degraded state
    state = recordFailure(state, { failureThreshold: 1, probeIntervalMs: 0 });
    expect(state.mode).toBe("degraded");

    handle = createPollSync(
      { intervalMs: 60_000, degradationConfig: { failureThreshold: 1, probeIntervalMs: 0 } },
      async () => ({ ok: true }),
      () => state,
      (s) => {
        state = s;
      },
    );
    await handle.poll();
    expect(state.mode).toBe("healthy");
  });

  test("failed poll records failure", async () => {
    let state = createDegradationState();
    handle = createPollSync(
      { intervalMs: 60_000, degradationConfig: { failureThreshold: 2, probeIntervalMs: 0 } },
      async () => ({ ok: false }),
      () => state,
      (s) => {
        state = s;
      },
    );
    await handle.poll();
    expect(state.failureCount).toBe(1);
    await handle.poll();
    expect(state.mode).toBe("degraded");
  });

  test("skips poll in degraded mode before probe interval", async () => {
    let pollCount = 0;
    let state = createDegradationState();
    state = recordFailure(state, { failureThreshold: 1, probeIntervalMs: 60_000 });

    handle = createPollSync(
      { intervalMs: 60_000, degradationConfig: { failureThreshold: 1, probeIntervalMs: 60_000 } },
      async () => {
        pollCount++;
        return { ok: true };
      },
      () => state,
      (s) => {
        state = s;
      },
    );
    await handle.poll();
    // Should skip because probe interval not elapsed
    expect(pollCount).toBe(0);
  });

  test("dispose stops timer", async () => {
    let pollCount = 0;
    let state = createDegradationState();
    handle = createPollSync(
      { intervalMs: 20 },
      async () => {
        pollCount++;
        return { ok: true };
      },
      () => state,
      (s) => {
        state = s;
      },
    );
    handle.dispose();
    handle = undefined;
    await new Promise((r) => setTimeout(r, 80));
    expect(pollCount).toBe(0);
  });
});
