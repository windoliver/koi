/**
 * Tests for the sliding observation window.
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core/ecs";
import type { AgentObservation } from "./types.js";
import { createObservationWindow } from "./window.js";

function makeObs(agent: string, round: number): AgentObservation {
  return {
    agentId: agentId(agent),
    round,
    timestamp: Date.now(),
    toolCallCounts: new Map([["read", 10]]),
    resourceAccessCounts: new Map(),
    trustScoreChanges: new Map(),
  };
}

describe("createObservationWindow", () => {
  test("empty window → empty observations", () => {
    const win = createObservationWindow(10);
    expect(win.observations()).toHaveLength(0);
  });

  test("empty window → latestRound is -1", () => {
    const win = createObservationWindow(10);
    expect(win.latestRound()).toBe(-1);
  });

  test("record within capacity", () => {
    const win = createObservationWindow(10);
    win.record(makeObs("a1", 1));
    win.record(makeObs("a2", 1));
    expect(win.observations()).toHaveLength(2);
    expect(win.latestRound()).toBe(1);
  });

  test("eviction at capacity — oldest rounds removed", () => {
    const win = createObservationWindow(3); // Max 3 rounds
    for (const round of [1, 2, 3, 4]) {
      win.record(makeObs("a1", round));
    }
    // Round 1 should be evicted
    expect(win.observationsForRound(1)).toHaveLength(0);
    expect(win.observationsForRound(2)).toHaveLength(1);
    expect(win.observationsForRound(3)).toHaveLength(1);
    expect(win.observationsForRound(4)).toHaveLength(1);
  });

  test("multiple agents in same round preserved", () => {
    const win = createObservationWindow(10);
    win.record(makeObs("a1", 1));
    win.record(makeObs("a2", 1));
    win.record(makeObs("a3", 1));
    expect(win.observationsForRound(1)).toHaveLength(3);
  });

  test("observationsForRound returns correct filtering", () => {
    const win = createObservationWindow(10);
    win.record(makeObs("a1", 1));
    win.record(makeObs("a1", 2));
    win.record(makeObs("a1", 3));
    expect(win.observationsForRound(2)).toHaveLength(1);
    expect(win.observationsForRound(2)[0]?.round).toBe(2);
  });

  test("observationsForRound for non-existent round → empty", () => {
    const win = createObservationWindow(10);
    win.record(makeObs("a1", 1));
    expect(win.observationsForRound(99)).toHaveLength(0);
  });

  test("latestRound tracks the highest round", () => {
    const win = createObservationWindow(10);
    win.record(makeObs("a1", 5));
    win.record(makeObs("a1", 3));
    win.record(makeObs("a1", 7));
    expect(win.latestRound()).toBe(7);
  });

  test("clear resets the window", () => {
    const win = createObservationWindow(10);
    win.record(makeObs("a1", 1));
    win.record(makeObs("a2", 2));
    win.clear();
    expect(win.observations()).toHaveLength(0);
    expect(win.latestRound()).toBe(-1);
  });

  test("observations returns a snapshot", () => {
    const win = createObservationWindow(10);
    win.record(makeObs("a1", 1));
    const snapshot = win.observations();
    win.record(makeObs("a2", 2));
    expect(snapshot).toHaveLength(1); // Snapshot not affected
  });
});
