import { describe, expect, mock, test } from "bun:test";
import type { GovernanceSnapshot } from "@koi/core/governance";
import { createAlertTracker } from "./alert-tracker.js";

function snapshot(variable: string, current: number, limit: number): GovernanceSnapshot {
  return {
    timestamp: 0,
    readings: [{ name: variable, current, limit, utilization: current / limit }],
    healthy: current < limit,
    violations: [],
  };
}

describe("createAlertTracker", () => {
  test("fires once at crossing 0.8", () => {
    const onAlert = mock(() => {});
    const tracker = createAlertTracker({ thresholds: [0.8, 0.95] });

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.5, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(0);

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.81, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(1);

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.85, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  test("fires both thresholds in single jump 0→0.96", () => {
    const onAlert = mock(() => {});
    const tracker = createAlertTracker({ thresholds: [0.8, 0.95] });

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.96, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  test("per-session dedup — different sessions track independently", () => {
    const onAlert = mock(() => {});
    const tracker = createAlertTracker({ thresholds: [0.8] });

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.85, 1), onAlert);
    tracker.checkAndFire("s2", snapshot("cost_usd", 0.85, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  test("cleanup clears fired set for session", () => {
    const onAlert = mock(() => {});
    const tracker = createAlertTracker({ thresholds: [0.8] });

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.85, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(1);

    tracker.cleanup("s1");
    tracker.checkAndFire("s1", snapshot("cost_usd", 0.85, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  test("unsorted thresholds still work (internal sort)", () => {
    const onAlert = mock(() => {});
    const tracker = createAlertTracker({ thresholds: [0.95, 0.8] });

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.9, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});
