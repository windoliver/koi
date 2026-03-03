import { describe, expect, test } from "bun:test";
import {
  type CircuitBreakerConfig,
  createCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "../circuit-breaker.js";

function makeConfig(overrides?: Partial<CircuitBreakerConfig>): CircuitBreakerConfig {
  return { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...overrides };
}

describe("createCircuitBreaker", () => {
  test("initial state is CLOSED", () => {
    const cb = createCircuitBreaker();
    expect(cb.getSnapshot().state).toBe("CLOSED");
  });

  test("initial failure count is zero", () => {
    const cb = createCircuitBreaker();
    expect(cb.getSnapshot().failureCount).toBe(0);
  });

  test("initial lastFailureAt is undefined", () => {
    const cb = createCircuitBreaker();
    expect(cb.getSnapshot().lastFailureAt).toBeUndefined();
  });
});

describe("CLOSED state", () => {
  test("isAllowed returns true", () => {
    const cb = createCircuitBreaker();
    expect(cb.isAllowed()).toBe(true);
  });

  test("stays CLOSED below failure threshold", () => {
    const config = makeConfig({ failureThreshold: 5 });
    const cb = createCircuitBreaker(config);

    for (let i = 0; i < 4; i++) {
      cb.recordFailure(500);
    }

    expect(cb.getSnapshot().state).toBe("CLOSED");
    expect(cb.getSnapshot().failureCount).toBe(4);
  });

  test("transitions to OPEN at failure threshold", () => {
    const config = makeConfig({ failureThreshold: 3 });
    const cb = createCircuitBreaker(config);

    cb.recordFailure(500);
    cb.recordFailure(500);
    const snap = cb.recordFailure(500);

    expect(snap.state).toBe("OPEN");
    expect(snap.failureCount).toBe(3);
  });

  test("successes do not affect state in CLOSED", () => {
    const cb = createCircuitBreaker();
    const snap = cb.recordSuccess();
    expect(snap.state).toBe("CLOSED");
  });

  test("only counts configured status codes", () => {
    const config = makeConfig({
      failureThreshold: 2,
      failureStatusCodes: [500, 503],
    });
    const cb = createCircuitBreaker(config);

    // 400 is not in failureStatusCodes — should not count
    cb.recordFailure(400);
    cb.recordFailure(400);

    expect(cb.getSnapshot().state).toBe("CLOSED");
    expect(cb.getSnapshot().failureCount).toBe(0);
  });

  test("counts failure when no status code provided", () => {
    const config = makeConfig({ failureThreshold: 2 });
    const cb = createCircuitBreaker(config);

    cb.recordFailure(); // no status code → always counts
    cb.recordFailure();

    expect(cb.getSnapshot().state).toBe("OPEN");
  });
});

describe("OPEN state", () => {
  test("isAllowed returns false", () => {
    const config = makeConfig({ failureThreshold: 1, cooldownMs: 60_000 });
    const now = 0;
    const cb = createCircuitBreaker(config, () => now);

    cb.recordFailure(500);
    expect(cb.getSnapshot().state).toBe("OPEN");
    expect(cb.isAllowed()).toBe(false);
  });

  test("transitions to HALF_OPEN after cooldown", () => {
    const config = makeConfig({ failureThreshold: 1, cooldownMs: 10_000 });
    let now = 0;
    const cb = createCircuitBreaker(config, () => now);

    cb.recordFailure(500);
    expect(cb.getSnapshot().state).toBe("OPEN");

    // Advance past cooldown
    now = 10_000;
    expect(cb.isAllowed()).toBe(true);
    expect(cb.getSnapshot().state).toBe("HALF_OPEN");
  });

  test("stays OPEN before cooldown expires", () => {
    const config = makeConfig({ failureThreshold: 1, cooldownMs: 10_000 });
    let now = 0;
    const cb = createCircuitBreaker(config, () => now);

    cb.recordFailure(500);

    now = 5_000; // Half of cooldown
    expect(cb.isAllowed()).toBe(false);
    expect(cb.getSnapshot().state).toBe("OPEN");
  });
});

describe("HALF_OPEN state", () => {
  test("isAllowed returns true (allows probe)", () => {
    const config = makeConfig({ failureThreshold: 1, cooldownMs: 100 });
    let now = 0;
    const cb = createCircuitBreaker(config, () => now);

    cb.recordFailure(500);
    now = 100; // Past cooldown
    expect(cb.isAllowed()).toBe(true);
    expect(cb.getSnapshot().state).toBe("HALF_OPEN");
  });

  test("probe success transitions to CLOSED", () => {
    const config = makeConfig({ failureThreshold: 1, cooldownMs: 100 });
    let now = 0;
    const cb = createCircuitBreaker(config, () => now);

    cb.recordFailure(500);
    now = 100;
    cb.isAllowed(); // → HALF_OPEN

    const snap = cb.recordSuccess();
    expect(snap.state).toBe("CLOSED");
  });

  test("probe success resets failure tracking", () => {
    const config = makeConfig({ failureThreshold: 1, cooldownMs: 100 });
    let now = 0;
    const cb = createCircuitBreaker(config, () => now);

    cb.recordFailure(500);
    now = 100;
    cb.isAllowed(); // → HALF_OPEN
    cb.recordSuccess();

    expect(cb.getSnapshot().failureCount).toBe(0);
  });

  test("probe failure transitions back to OPEN", () => {
    const config = makeConfig({ failureThreshold: 1, cooldownMs: 100 });
    let now = 0;
    const cb = createCircuitBreaker(config, () => now);

    cb.recordFailure(500);
    now = 100;
    cb.isAllowed(); // → HALF_OPEN

    const snap = cb.recordFailure(500);
    expect(snap.state).toBe("OPEN");
  });
});

describe("ring buffer behavior", () => {
  test("old failures outside window are not counted", () => {
    const config = makeConfig({
      failureThreshold: 3,
      failureWindowMs: 1_000,
    });
    let now = 0;
    const cb = createCircuitBreaker(config, () => now);

    cb.recordFailure(500); // t=0
    cb.recordFailure(500); // t=0

    now = 1_001; // Window expired for first two failures
    cb.recordFailure(500); // t=1001 — only this one is in window

    expect(cb.getSnapshot().state).toBe("CLOSED");
    expect(cb.getSnapshot().failureCount).toBe(1);
  });

  test("ring buffer wraps around correctly", () => {
    const config = makeConfig({
      failureThreshold: 3,
      failureWindowMs: 10_000,
    });
    let now = 0;
    const cb = createCircuitBreaker(config, () => now);

    // Fill ring buffer (3 slots)
    cb.recordFailure(500); // slot 0
    now = 1_000;
    cb.recordFailure(500); // slot 1
    now = 2_000;
    // Record a success to prevent OPEN transition
    cb.reset();

    // Continue filling — wraps around
    now = 3_000;
    cb.recordFailure(500); // slot 0
    now = 4_000;
    cb.recordFailure(500); // slot 1
    now = 5_000;
    cb.recordFailure(500); // slot 2 → threshold reached

    expect(cb.getSnapshot().state).toBe("OPEN");
  });
});

describe("getSnapshot", () => {
  test("returns snapshot with expected shape", () => {
    const cb = createCircuitBreaker();
    const snap = cb.getSnapshot();
    expect(snap.state).toBe("CLOSED");
    expect(snap.failureCount).toBe(0);
    expect(snap.lastFailureAt).toBeUndefined();
    expect(typeof snap.lastTransitionAt).toBe("number");
  });

  test("tracks lastFailureAt", () => {
    let now = 1000;
    const cb = createCircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG, () => now);

    cb.recordFailure(500);
    expect(cb.getSnapshot().lastFailureAt).toBe(1000);

    now = 2000;
    cb.recordFailure(500);
    expect(cb.getSnapshot().lastFailureAt).toBe(2000);
  });
});

describe("reset", () => {
  test("resets state to CLOSED", () => {
    const config = makeConfig({ failureThreshold: 1 });
    const cb = createCircuitBreaker(config);

    cb.recordFailure(500);
    expect(cb.getSnapshot().state).toBe("OPEN");

    cb.reset();
    expect(cb.getSnapshot().state).toBe("CLOSED");
  });

  test("resets failure count to zero", () => {
    const cb = createCircuitBreaker();
    cb.recordFailure(500);
    cb.recordFailure(500);

    cb.reset();
    expect(cb.getSnapshot().failureCount).toBe(0);
  });
});

describe("injectable clock", () => {
  test("uses injected clock for timestamps", () => {
    let now = 5000;
    const cb = createCircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG, () => now);

    expect(cb.getSnapshot().lastTransitionAt).toBe(5000);

    now = 6000;
    cb.recordFailure(500);
    expect(cb.getSnapshot().lastFailureAt).toBe(6000);
  });
});
