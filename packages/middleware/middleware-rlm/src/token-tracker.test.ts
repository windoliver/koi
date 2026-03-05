import { describe, expect, test } from "bun:test";
import { createTokenTracker } from "./token-tracker.js";

describe("createTokenTracker", () => {
  test("starts at zero", () => {
    const tracker = createTokenTracker(1000);
    expect(tracker.current()).toBe(0);
    expect(tracker.utilization()).toBe(0);
    expect(tracker.remaining()).toBe(1000);
  });

  test("add estimates tokens as chars/4", () => {
    const tracker = createTokenTracker(1000);
    tracker.add("x".repeat(100)); // 100 chars = 25 tokens
    expect(tracker.current()).toBe(25);
  });

  test("add rounds up", () => {
    const tracker = createTokenTracker(1000);
    tracker.add("abc"); // 3 chars = ceil(3/4) = 1 token
    expect(tracker.current()).toBe(1);
  });

  test("addTokens adds raw count", () => {
    const tracker = createTokenTracker(1000);
    tracker.addTokens(50);
    expect(tracker.current()).toBe(50);
  });

  test("utilization is fraction of capacity", () => {
    const tracker = createTokenTracker(100);
    tracker.addTokens(80);
    expect(tracker.utilization()).toBeCloseTo(0.8);
  });

  test("utilization can exceed 1.0", () => {
    const tracker = createTokenTracker(100);
    tracker.addTokens(150);
    expect(tracker.utilization()).toBe(1.5);
  });

  test("remaining clamps at zero", () => {
    const tracker = createTokenTracker(100);
    tracker.addTokens(150);
    expect(tracker.remaining()).toBe(0);
  });

  test("uses default capacity when not specified", () => {
    const tracker = createTokenTracker();
    expect(tracker.capacity).toBe(100_000);
  });

  test("accumulates multiple add calls", () => {
    const tracker = createTokenTracker(1000);
    tracker.add("x".repeat(40)); // 10 tokens
    tracker.addTokens(20);
    tracker.add("y".repeat(80)); // 20 tokens
    expect(tracker.current()).toBe(50);
  });
});
