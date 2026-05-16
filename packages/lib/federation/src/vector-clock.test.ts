import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import type { FederationSyncEvent } from "./types.js";
import {
  compareVectorClock,
  detectEventConflict,
  incrementVectorClock,
  mergeVectorClock,
  pruneVectorClock,
  resolveEventConflict,
} from "./vector-clock.js";

function event(
  zone: string,
  sequence: number,
  vectorClock: Readonly<Record<string, number>>,
  data: Readonly<Record<string, unknown>>,
  emittedAt: number = sequence,
): FederationSyncEvent {
  return {
    kind: "state.write",
    originZoneId: zoneId(zone),
    sequence,
    vectorClock,
    data,
    emittedAt,
  };
}

describe("vector clock operations", () => {
  test("increments a zone component immutably", () => {
    const original = { "zone-a": 1 };
    const incremented = incrementVectorClock(original, "zone-a");

    expect(incremented).toEqual({ "zone-a": 2 });
    expect(original).toEqual({ "zone-a": 1 });
    expect(incrementVectorClock(original, "zone-b")).toEqual({ "zone-a": 1, "zone-b": 1 });
  });

  test("merges clocks by component-wise maximum", () => {
    expect(mergeVectorClock({ "zone-a": 1, "zone-b": 4 }, { "zone-a": 3, "zone-c": 2 })).toEqual({
      "zone-a": 3,
      "zone-b": 4,
      "zone-c": 2,
    });
  });

  test("compares clocks as before, after, equal, or concurrent", () => {
    expect(compareVectorClock({ "zone-a": 1 }, { "zone-a": 2 })).toBe("before");
    expect(compareVectorClock({ "zone-a": 2 }, { "zone-a": 1 })).toBe("after");
    expect(compareVectorClock({ "zone-a": 1 }, { "zone-a": 1 })).toBe("equal");
    expect(compareVectorClock({ "zone-a": 1 }, { "zone-b": 1 })).toBe("concurrent");
  });

  test("prunes idle zones while preserving zones with unknown activity", () => {
    expect(
      pruneVectorClock({ active: 3, idle: 2, unknown: 1 }, { active: 1_000, idle: 100 }, 500),
    ).toEqual({ active: 3, unknown: 1 });
  });
});

describe("event conflict resolution", () => {
  test("detects concurrent writes to the same shared resource", () => {
    const left = event("zone-a", 1, { "zone-a": 1 }, { resourceKey: "shared-state", a: 1 });
    const right = event("zone-b", 1, { "zone-b": 1 }, { resourceKey: "shared-state", b: 2 });

    expect(detectEventConflict(left, right)).toBe(true);
    expect(detectEventConflict(left, { ...right, data: { resourceKey: "other" } })).toBe(false);
    expect(
      detectEventConflict(left, {
        ...right,
        vectorClock: { "zone-a": 2, "zone-b": 1 },
      }),
    ).toBe(false);
  });

  test("last-writer-wins chooses latest timestamp with deterministic zone tie-break", () => {
    const early = event("zone-a", 1, { "zone-a": 1 }, { resourceKey: "shared", value: "a" }, 10);
    const late = event("zone-b", 1, { "zone-b": 1 }, { resourceKey: "shared", value: "b" }, 20);

    const byTimestamp = resolveEventConflict(early, late, "lww");
    expect(byTimestamp.kind).toBe("resolved");
    if (byTimestamp.kind === "resolved") {
      expect(byTimestamp.event).toBe(late);
    }

    const byZone = resolveEventConflict(
      { ...early, emittedAt: 20 },
      { ...late, emittedAt: 20 },
      "lww",
    );
    expect(byZone.kind).toBe("resolved");
    if (byZone.kind === "resolved") {
      expect(byZone.event.originZoneId).toBe(zoneId("zone-b"));
    }
  });

  test("merge resolution combines data and vector clocks", () => {
    const left = event("zone-a", 2, { "zone-a": 2 }, { resourceKey: "shared", a: 1 }, 10);
    const right = event("zone-b", 3, { "zone-b": 3 }, { resourceKey: "shared", b: 2 }, 20);

    const result = resolveEventConflict(left, right, "merge");
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.event.data).toEqual({ resourceKey: "shared", a: 1, b: 2 });
      expect(result.event.vectorClock).toEqual({ "zone-a": 2, "zone-b": 3 });
      expect(result.event.sequence).toBe(3);
    }
  });

  test("manual resolution returns a report without selecting a winner", () => {
    const left = event("zone-a", 1, { "zone-a": 1 }, { resourceKey: "shared", a: 1 });
    const right = event("zone-b", 1, { "zone-b": 1 }, { resourceKey: "shared", b: 2 });

    const result = resolveEventConflict(left, right, "manual");
    expect(result.kind).toBe("manual");
    if (result.kind === "manual") {
      expect(result.report.resourceKey).toBe("shared");
      expect(result.report.order).toBe("concurrent");
    }
  });
});
