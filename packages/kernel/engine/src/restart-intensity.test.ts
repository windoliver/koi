import { describe, expect, test } from "bun:test";
import { createFakeClock } from "./clock.js";
import { createRestartIntensityTracker } from "./restart-intensity.js";

describe("createRestartIntensityTracker", () => {
  test("records restart and counts within window", () => {
    const clock = createFakeClock(0);
    const tracker = createRestartIntensityTracker({
      maxRestarts: 5,
      windowMs: 60_000,
      clock,
    });

    tracker.record("child-a");
    tracker.record("child-a");

    expect(tracker.attemptsInWindow("child-a")).toBe(2);
    expect(tracker.isExhausted("child-a")).toBe(false);
  });

  test("exactly at budget limit marks exhausted", () => {
    const clock = createFakeClock(0);
    const tracker = createRestartIntensityTracker({
      maxRestarts: 3,
      windowMs: 60_000,
      clock,
    });

    tracker.record("child-a");
    clock.advance(1_000);
    tracker.record("child-a");
    clock.advance(1_000);
    tracker.record("child-a");

    expect(tracker.attemptsInWindow("child-a")).toBe(3);
    expect(tracker.isExhausted("child-a")).toBe(true);
  });

  test("budget recovers after window slides (oldest restart expires)", () => {
    const clock = createFakeClock(0);
    const tracker = createRestartIntensityTracker({
      maxRestarts: 3,
      windowMs: 10_000,
      clock,
    });

    // Record 3 restarts at t=0, t=1000, t=2000
    tracker.record("child-a");
    clock.advance(1_000);
    tracker.record("child-a");
    clock.advance(1_000);
    tracker.record("child-a");

    expect(tracker.isExhausted("child-a")).toBe(true);

    // Advance past the window for the first restart (t=0 + 10_000 = 10_000)
    // At t=10_001, the restart at t=0 is outside the window
    clock.advance(8_001);

    expect(tracker.attemptsInWindow("child-a")).toBe(2);
    expect(tracker.isExhausted("child-a")).toBe(false);
  });

  test("rapid burst within window marks exhausted", () => {
    const clock = createFakeClock(0);
    const tracker = createRestartIntensityTracker({
      maxRestarts: 2,
      windowMs: 60_000,
      clock,
    });

    // Two restarts at the same timestamp
    tracker.record("child-a");
    tracker.record("child-a");

    expect(tracker.isExhausted("child-a")).toBe(true);
  });

  test("multiple children tracked independently", () => {
    const clock = createFakeClock(0);
    const tracker = createRestartIntensityTracker({
      maxRestarts: 2,
      windowMs: 60_000,
      clock,
    });

    tracker.record("child-a");
    tracker.record("child-a");
    tracker.record("child-b");

    expect(tracker.isExhausted("child-a")).toBe(true);
    expect(tracker.isExhausted("child-b")).toBe(false);
    expect(tracker.attemptsInWindow("child-b")).toBe(1);
  });

  test("reset clears history for one child", () => {
    const clock = createFakeClock(0);
    const tracker = createRestartIntensityTracker({
      maxRestarts: 2,
      windowMs: 60_000,
      clock,
    });

    tracker.record("child-a");
    tracker.record("child-a");
    tracker.record("child-b");

    expect(tracker.isExhausted("child-a")).toBe(true);

    tracker.reset("child-a");

    expect(tracker.attemptsInWindow("child-a")).toBe(0);
    expect(tracker.isExhausted("child-a")).toBe(false);
    // child-b unaffected
    expect(tracker.attemptsInWindow("child-b")).toBe(1);
  });

  test("zero maxRestarts means always exhausted", () => {
    const clock = createFakeClock(0);
    const tracker = createRestartIntensityTracker({
      maxRestarts: 0,
      windowMs: 60_000,
      clock,
    });

    // Exhausted even without any restarts recorded
    expect(tracker.isExhausted("child-a")).toBe(true);
  });

  test("restart at window boundary (sliding correctness)", () => {
    const clock = createFakeClock(0);
    const tracker = createRestartIntensityTracker({
      maxRestarts: 2,
      windowMs: 10_000,
      clock,
    });

    // Record at t=0
    tracker.record("child-a");
    // Record at t=10_000 (exactly at window boundary)
    clock.advance(10_000);
    tracker.record("child-a");

    // At t=10_000, the restart at t=0 is exactly at cutoff (now - window = 0)
    // cutoff = 10_000 - 10_000 = 0. Timestamps > cutoff count, so t=0 does NOT count.
    expect(tracker.attemptsInWindow("child-a")).toBe(1);
    expect(tracker.isExhausted("child-a")).toBe(false);
  });

  test("unknown child returns zero attempts and not exhausted", () => {
    const clock = createFakeClock(0);
    const tracker = createRestartIntensityTracker({
      maxRestarts: 5,
      windowMs: 60_000,
      clock,
    });

    expect(tracker.attemptsInWindow("unknown")).toBe(0);
    expect(tracker.isExhausted("unknown")).toBe(false);
  });

  test("ring buffer trims to maxRestarts size", () => {
    const clock = createFakeClock(0);
    const tracker = createRestartIntensityTracker({
      maxRestarts: 3,
      windowMs: 60_000,
      clock,
    });

    // Record 5 restarts — ring buffer should only keep last 3
    for (let i = 0; i < 5; i++) {
      clock.advance(100);
      tracker.record("child-a");
    }

    expect(tracker.attemptsInWindow("child-a")).toBe(3);
  });
});
