/**
 * Scenario: Both zones update same resource while partitioned.
 * LWW picks higher emittedAt consistently.
 */
import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import { resolveConflict } from "../../sync-protocol.js";
import { createTestEvent } from "../harness.js";

describe("concurrent writes", () => {
  test("LWW picks the event with higher emittedAt", () => {
    const eventA = createTestEvent("zone-a", 1, 1000);
    const eventB = createTestEvent("zone-b", 1, 2000);

    const winner = resolveConflict(eventA, eventB);
    expect(winner).toBe(eventB);
    expect(winner.originZoneId).toBe(zoneId("zone-b"));
  });

  test("LWW tie-breaks by zone ID deterministically", () => {
    const eventA = createTestEvent("zone-a", 1, 1000);
    const eventB = createTestEvent("zone-b", 1, 1000);

    // zone-b > zone-a lexicographically
    const winner = resolveConflict(eventA, eventB);
    expect(winner.originZoneId).toBe(zoneId("zone-b"));

    // Same result regardless of argument order
    const winner2 = resolveConflict(eventB, eventA);
    expect(winner2.originZoneId).toBe(zoneId("zone-b"));
  });

  test("consistent result across multiple conflict resolutions", () => {
    const eventA = createTestEvent("zone-a", 1, 1500);
    const eventB = createTestEvent("zone-b", 1, 2000);
    const eventC = createTestEvent("zone-c", 1, 1800);

    // Pairwise resolution should always pick zone-b (highest emittedAt)
    const ab = resolveConflict(eventA, eventB);
    const bc = resolveConflict(eventB, eventC);
    expect(ab.originZoneId).toBe(zoneId("zone-b"));
    expect(bc.originZoneId).toBe(zoneId("zone-b"));
  });
});
