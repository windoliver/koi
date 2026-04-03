import { describe, expect, test } from "bun:test";
import type { DegradationConfig } from "./config.js";
import {
  createDegradationState,
  recordFailure,
  recordSuccess,
  shouldProbe,
} from "./degradation.js";

const CONFIG: DegradationConfig = {
  failureThreshold: 3,
  probeIntervalMs: 10_000,
} as const;

describe("degradation state machine", () => {
  test("starts in healthy mode", () => {
    const state = createDegradationState();
    expect(state.mode).toBe("healthy");
    expect(state.failureCount).toBe(0);
    expect(state.degradedSince).toBeUndefined();
  });

  test("stays healthy below threshold", () => {
    let state = createDegradationState();
    state = recordFailure(state, CONFIG);
    expect(state.mode).toBe("healthy");
    expect(state.failureCount).toBe(1);

    state = recordFailure(state, CONFIG);
    expect(state.mode).toBe("healthy");
    expect(state.failureCount).toBe(2);
  });

  test("transitions to degraded at threshold", () => {
    let state = createDegradationState();
    state = recordFailure(state, CONFIG);
    state = recordFailure(state, CONFIG);
    state = recordFailure(state, CONFIG);
    expect(state.mode).toBe("degraded");
    expect(state.failureCount).toBe(3);
    expect(state.degradedSince).toBeDefined();
  });

  test("stays degraded on additional failures", () => {
    let state = createDegradationState();
    for (let i = 0; i < 5; i++) {
      state = recordFailure(state, CONFIG);
    }
    expect(state.mode).toBe("degraded");
    expect(state.failureCount).toBe(5);
  });

  test("recovers to healthy on success", () => {
    let state = createDegradationState();
    for (let i = 0; i < 3; i++) {
      state = recordFailure(state, CONFIG);
    }
    expect(state.mode).toBe("degraded");

    state = recordSuccess(state);
    expect(state.mode).toBe("healthy");
    expect(state.failureCount).toBe(0);
    expect(state.degradedSince).toBeUndefined();
  });

  test("success resets failure count even when healthy", () => {
    let state = createDegradationState();
    state = recordFailure(state, CONFIG);
    state = recordFailure(state, CONFIG);
    expect(state.failureCount).toBe(2);

    state = recordSuccess(state);
    expect(state.failureCount).toBe(0);
  });
});

describe("shouldProbe", () => {
  test("returns false when healthy", () => {
    const state = createDegradationState();
    expect(shouldProbe(state, CONFIG)).toBe(false);
  });

  test("returns false when recently degraded", () => {
    let state = createDegradationState();
    for (let i = 0; i < 3; i++) {
      state = recordFailure(state, CONFIG);
    }
    // Immediately after degrading — not enough time elapsed
    expect(shouldProbe(state, CONFIG, Date.now())).toBe(false);
  });

  test("returns true after probe interval elapsed", () => {
    let state = createDegradationState();
    for (let i = 0; i < 3; i++) {
      state = recordFailure(state, CONFIG);
    }
    const future = Date.now() + CONFIG.probeIntervalMs + 1;
    expect(shouldProbe(state, CONFIG, future)).toBe(true);
  });
});
