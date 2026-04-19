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

  test("per-variable thresholds override global thresholds", () => {
    const fired: Array<[number, string]> = [];
    const tracker = createAlertTracker({
      thresholds: [0.8],
      perVariableThresholds: { cost_usd: [0.5, 0.95] },
    });
    const snap: GovernanceSnapshot = {
      timestamp: Date.now(),
      healthy: true,
      violations: [],
      readings: [
        { name: "cost_usd", current: 0.55, limit: 1.0, utilization: 0.55 },
        { name: "turn_count", current: 8, limit: 10, utilization: 0.8 },
      ],
    };
    tracker.checkAndFire("s1", snap, (pct, v) => fired.push([pct, v]));
    expect(fired).toEqual([
      [0.55, "cost_usd"],
      [0.8, "turn_count"],
    ]);
  });

  test("per-variable threshold dedup is independent from global", () => {
    const fired: string[] = [];
    const tracker = createAlertTracker({
      thresholds: [0.8],
      perVariableThresholds: { cost_usd: [0.8] },
    });
    const snap: GovernanceSnapshot = {
      timestamp: Date.now(),
      healthy: true,
      violations: [],
      readings: [{ name: "cost_usd", current: 0.85, limit: 1.0, utilization: 0.85 }],
    };
    tracker.checkAndFire("s1", snap, (_, v) => fired.push(v));
    tracker.checkAndFire("s1", snap, (_, v) => fired.push(v));
    expect(fired).toEqual(["cost_usd"]);
  });
});
