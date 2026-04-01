/**
 * Exponential backoff tracker tests.
 *
 * Tests: first attempt proceeds, consecutive failures double wait,
 * cap, success resets, partial recovery.
 */

import { describe, expect, it } from "bun:test";
import { createBackoffTracker } from "./backoff.js";
import type { CompactionState } from "./types.js";
import { INITIAL_STATE } from "./types.js";

describe("createBackoffTracker", () => {
  const tracker = createBackoffTracker(1, 32);

  function stateAt(turn: number, failures = 0, skipUntil = 0): CompactionState {
    return {
      ...INITIAL_STATE,
      currentTurn: turn,
      consecutiveFailures: failures,
      skipUntilTurn: skipUntil,
    };
  }

  describe("shouldSkip", () => {
    it("does not skip on first attempt (no failures)", () => {
      expect(tracker.shouldSkip(stateAt(0))).toBe(false);
    });

    it("skips when current turn is before skipUntilTurn", () => {
      expect(tracker.shouldSkip(stateAt(2, 1, 5))).toBe(true);
    });

    it("skips when current turn equals skipUntilTurn (inclusive)", () => {
      expect(tracker.shouldSkip(stateAt(5, 1, 5))).toBe(true);
    });

    it("does not skip when current turn is past skipUntilTurn", () => {
      expect(tracker.shouldSkip(stateAt(6, 1, 5))).toBe(false);
    });
  });

  describe("recordFailure", () => {
    it("sets skip to 1 turn after first failure", () => {
      const state = stateAt(5);
      const next = tracker.recordFailure(state);
      expect(next.consecutiveFailures).toBe(1);
      expect(next.skipUntilTurn).toBe(6); // currentTurn (5) + initialSkip (1)
    });

    it("doubles skip after second consecutive failure", () => {
      const state = stateAt(7, 1, 6); // already had 1 failure
      const next = tracker.recordFailure(state);
      expect(next.consecutiveFailures).toBe(2);
      expect(next.skipUntilTurn).toBe(9); // 7 + 2
    });

    it("doubles again after third failure", () => {
      const state = stateAt(10, 2, 9);
      const next = tracker.recordFailure(state);
      expect(next.consecutiveFailures).toBe(3);
      expect(next.skipUntilTurn).toBe(14); // 10 + 4
    });

    it("caps skip at configured maximum", () => {
      // After many failures, skip should cap at 32
      const state = stateAt(100, 10, 99); // 2^10 = 1024, way above cap
      const next = tracker.recordFailure(state);
      expect(next.consecutiveFailures).toBe(11);
      expect(next.skipUntilTurn).toBe(132); // 100 + 32 (capped)
    });
  });

  describe("recordSuccess", () => {
    it("resets consecutive failures to 0", () => {
      const state = stateAt(15, 5, 20);
      const next = tracker.recordSuccess(state);
      expect(next.consecutiveFailures).toBe(0);
    });

    it("resets skipUntilTurn to 0", () => {
      const state = stateAt(15, 5, 20);
      const next = tracker.recordSuccess(state);
      expect(next.skipUntilTurn).toBe(0);
    });
  });

  describe("partial recovery", () => {
    it("success then immediate failure restarts backoff from 1", () => {
      // Simulate: several failures → success → new failure
      const afterSuccess = tracker.recordSuccess(stateAt(20, 3, 18));
      expect(afterSuccess.consecutiveFailures).toBe(0);

      const afterNewFailure = tracker.recordFailure({ ...afterSuccess, currentTurn: 21 });
      expect(afterNewFailure.consecutiveFailures).toBe(1);
      expect(afterNewFailure.skipUntilTurn).toBe(22); // 21 + 1 (fresh start)
    });
  });

  describe("custom config", () => {
    it("respects custom initialSkip", () => {
      const custom = createBackoffTracker(3, 32);
      const next = custom.recordFailure(stateAt(0));
      expect(next.skipUntilTurn).toBe(3); // 0 + 3
    });

    it("respects custom cap", () => {
      const custom = createBackoffTracker(1, 8);
      // After 10 failures, skip should cap at 8
      const state = stateAt(50, 10, 49);
      const next = custom.recordFailure(state);
      expect(next.skipUntilTurn).toBe(58); // 50 + 8 (capped)
    });
  });
});
