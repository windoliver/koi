import { describe, expect, test } from "bun:test";
import {
  createDegradationState,
  recordFailure,
  recordSuccess,
  shouldProbe,
} from "./degradation.js";

const cfg = { failureThreshold: 3, probeIntervalMs: 10_000 };

describe("degradation", () => {
  test("starts healthy", () => {
    const s = createDegradationState(1000);
    expect(s.mode).toBe("healthy");
    expect(s.failureCount).toBe(0);
    expect(s.degradedSince).toBeUndefined();
  });

  test("transitions to degraded at threshold", () => {
    let s = createDegradationState(1000);
    s = recordFailure(s, cfg, 1100);
    s = recordFailure(s, cfg, 1200);
    expect(s.mode).toBe("healthy");
    s = recordFailure(s, cfg, 1300);
    expect(s.mode).toBe("degraded");
    expect(s.degradedSince).toBe(1300);
    expect(s.failureCount).toBe(3);
  });

  test("recordSuccess resets to healthy", () => {
    let s = createDegradationState(1000);
    s = recordFailure(s, cfg);
    s = recordFailure(s, cfg);
    s = recordFailure(s, cfg);
    s = recordSuccess(s, 2000);
    expect(s.mode).toBe("healthy");
    expect(s.failureCount).toBe(0);
    expect(s.degradedSince).toBeUndefined();
    expect(s.lastSuccessAt).toBe(2000);
  });

  test("shouldProbe is false while healthy", () => {
    const s = createDegradationState(1000);
    expect(shouldProbe(s, cfg, 999_999)).toBe(false);
  });

  test("shouldProbe is true once probe interval elapses while degraded", () => {
    let s = createDegradationState(1000);
    s = recordFailure(s, cfg, 1100);
    s = recordFailure(s, cfg, 1200);
    s = recordFailure(s, cfg, 1300);
    expect(shouldProbe(s, cfg, 1300 + 9_999)).toBe(false);
    expect(shouldProbe(s, cfg, 1300 + 10_000)).toBe(true);
  });

  test("a failed probe re-arms the cooldown so a down Nexus is not probed every miss", () => {
    // Round-2 finding 3: without lastFailureAt, shouldProbe stays true forever
    // once the initial probe interval has elapsed because degradedSince never
    // moves. That amplifies load on an already failing Nexus.
    let s = createDegradationState(1000);
    s = recordFailure(s, cfg, 1100);
    s = recordFailure(s, cfg, 1200);
    s = recordFailure(s, cfg, 1300); // → degraded
    // Cooldown elapses; first probe fires and fails:
    expect(shouldProbe(s, cfg, 1300 + 10_000)).toBe(true);
    s = recordFailure(s, cfg, 1300 + 10_000);
    // Immediately after the failed probe, the cooldown must reapply.
    expect(shouldProbe(s, cfg, 1300 + 10_001)).toBe(false);
    // ... and only re-arm once the FULL probe interval has elapsed since the
    // last failure (not since the original degradation transition).
    expect(shouldProbe(s, cfg, 1300 + 10_000 + 9_999)).toBe(false);
    expect(shouldProbe(s, cfg, 1300 + 10_000 + 10_000)).toBe(true);
  });
});
