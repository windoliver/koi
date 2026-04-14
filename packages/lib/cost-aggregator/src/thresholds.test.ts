import { describe, expect, test } from "bun:test";
import type { ThresholdAlert } from "./thresholds.js";
import { createThresholdTracker, DEFAULT_THRESHOLDS } from "./thresholds.js";

function collectAlerts(
  budget: number,
  thresholds?: readonly number[],
): {
  readonly alerts: ThresholdAlert[];
  readonly tracker: ReturnType<typeof createThresholdTracker>;
} {
  const alerts: ThresholdAlert[] = [];
  const tracker = createThresholdTracker({
    budget,
    thresholds,
    onAlert: (a) => alerts.push(a),
  });
  return { alerts, tracker };
}

describe("createThresholdTracker", () => {
  // -------------------------------------------------------------------------
  // Normal crossing
  // -------------------------------------------------------------------------

  test("fires alert when threshold is crossed", () => {
    const { alerts, tracker } = collectAlerts(100, [0.5]);
    tracker.check("s1", 51);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.threshold).toBe(0.5);
    expect(alerts[0]?.sessionId).toBe("s1");
  });

  test("exact boundary fires", () => {
    const { alerts, tracker } = collectAlerts(100, [0.5]);
    tracker.check("s1", 50); // exactly 50%
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.threshold).toBe(0.5);
  });

  test("below threshold does not fire", () => {
    const { alerts, tracker } = collectAlerts(100, [0.5]);
    tracker.check("s1", 49.99);
    expect(alerts).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Skip-over: jump past multiple thresholds
  // -------------------------------------------------------------------------

  test("skip-over fires all crossed thresholds", () => {
    const { alerts, tracker } = collectAlerts(100, [0.5, 0.75, 0.9]);
    tracker.check("s1", 80); // crosses 50% and 75%
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.threshold).toBe(0.5);
    expect(alerts[1]?.threshold).toBe(0.75);
  });

  test("skip-over from 0 to 100% fires all thresholds", () => {
    const { alerts, tracker } = collectAlerts(100, [0.5, 0.75, 0.9]);
    tracker.check("s1", 100);
    expect(alerts).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Exactly-once semantics
  // -------------------------------------------------------------------------

  test("does not re-fire on subsequent check at same level", () => {
    const { alerts, tracker } = collectAlerts(100, [0.5]);
    tracker.check("s1", 51);
    tracker.check("s1", 55);
    tracker.check("s1", 60);
    expect(alerts).toHaveLength(1);
  });

  test("re-crossing after drop does NOT re-fire", () => {
    const { alerts, tracker } = collectAlerts(100, [0.5]);
    tracker.check("s1", 55); // fires 50%
    tracker.check("s1", 45); // drops below — no fire
    tracker.check("s1", 55); // re-crosses — should NOT re-fire
    expect(alerts).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Per-session isolation
  // -------------------------------------------------------------------------

  test("different sessions have independent threshold state", () => {
    const { alerts, tracker } = collectAlerts(100, [0.5]);
    tracker.check("s1", 55); // fires for s1
    tracker.check("s2", 55); // fires for s2
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.sessionId).toBe("s1");
    expect(alerts[1]?.sessionId).toBe("s2");
  });

  test("clearSession resets threshold state", () => {
    const { alerts, tracker } = collectAlerts(100, [0.5]);
    tracker.check("s1", 55); // fires
    tracker.clearSession("s1");
    // After clear, the threshold should fire again (new session lifecycle)
    tracker.check("s1", 55);
    expect(alerts).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Zero/edge budget
  // -------------------------------------------------------------------------

  test("zero budget does not fire", () => {
    const { alerts, tracker } = collectAlerts(0, [0.5]);
    tracker.check("s1", 1);
    expect(alerts).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Default thresholds
  // -------------------------------------------------------------------------

  test("uses default thresholds when none specified", () => {
    const alerts: ThresholdAlert[] = [];
    const tracker = createThresholdTracker({
      budget: 100,
      onAlert: (a) => alerts.push(a),
    });
    tracker.check("s1", 95);
    expect(alerts).toHaveLength(3); // 50%, 75%, 90%
    expect(DEFAULT_THRESHOLDS).toEqual([0.5, 0.75, 0.9]);
  });

  // -------------------------------------------------------------------------
  // Alert payload correctness
  // -------------------------------------------------------------------------

  test("alert payload includes correct values", () => {
    const { alerts, tracker } = collectAlerts(200, [0.75]);
    tracker.check("s1", 160);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    if (alert === undefined) throw new Error("alert should be defined");
    expect(alert.sessionId).toBe("s1");
    expect(alert.threshold).toBe(0.75);
    expect(alert.currentSpend).toBe(160);
    expect(alert.budget).toBe(200);
    expect(alert.percentage).toBe(0.8);
  });
});
