import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import type { FederationSyncEvent, SyncCursor, VectorClock } from "../types.js";
import {
  compareClock,
  incrementClock,
  isAfterCursor,
  mergeClock,
  pruneClock,
} from "../vector-clock.js";

describe("incrementClock", () => {
  test("increments existing zone component", () => {
    const clock: VectorClock = { "zone-a": 3, "zone-b": 1 };
    const result = incrementClock(clock, "zone-a");
    expect(result).toEqual({ "zone-a": 4, "zone-b": 1 });
  });

  test("initializes missing zone component to 1", () => {
    const clock: VectorClock = { "zone-a": 3 };
    const result = incrementClock(clock, "zone-b");
    expect(result).toEqual({ "zone-a": 3, "zone-b": 1 });
  });

  test("does not mutate original clock", () => {
    const clock: VectorClock = { "zone-a": 1 };
    incrementClock(clock, "zone-a");
    expect(clock).toEqual({ "zone-a": 1 });
  });

  test("handles empty clock", () => {
    const result = incrementClock({}, "zone-a");
    expect(result).toEqual({ "zone-a": 1 });
  });
});

describe("mergeClock", () => {
  test("takes component-wise max", () => {
    const a: VectorClock = { "zone-a": 3, "zone-b": 1 };
    const b: VectorClock = { "zone-a": 1, "zone-b": 5 };
    expect(mergeClock(a, b)).toEqual({ "zone-a": 3, "zone-b": 5 });
  });

  test("includes keys only in one clock", () => {
    const a: VectorClock = { "zone-a": 2 };
    const b: VectorClock = { "zone-b": 3 };
    expect(mergeClock(a, b)).toEqual({ "zone-a": 2, "zone-b": 3 });
  });

  test("handles empty clocks", () => {
    expect(mergeClock({}, {})).toEqual({});
    expect(mergeClock({ "zone-a": 1 }, {})).toEqual({ "zone-a": 1 });
    expect(mergeClock({}, { "zone-b": 2 })).toEqual({ "zone-b": 2 });
  });

  test("does not mutate inputs", () => {
    const a: VectorClock = { "zone-a": 1 };
    const b: VectorClock = { "zone-a": 2 };
    mergeClock(a, b);
    expect(a).toEqual({ "zone-a": 1 });
    expect(b).toEqual({ "zone-a": 2 });
  });
});

describe("compareClock", () => {
  test("returns equal for identical clocks", () => {
    expect(compareClock({ "zone-a": 1 }, { "zone-a": 1 })).toBe("equal");
  });

  test("returns equal for empty clocks", () => {
    expect(compareClock({}, {})).toBe("equal");
  });

  test("returns before when a < b", () => {
    const a: VectorClock = { "zone-a": 1, "zone-b": 1 };
    const b: VectorClock = { "zone-a": 2, "zone-b": 1 };
    expect(compareClock(a, b)).toBe("before");
  });

  test("returns after when a > b", () => {
    const a: VectorClock = { "zone-a": 3, "zone-b": 2 };
    const b: VectorClock = { "zone-a": 1, "zone-b": 2 };
    expect(compareClock(a, b)).toBe("after");
  });

  test("returns concurrent when neither dominates", () => {
    const a: VectorClock = { "zone-a": 2, "zone-b": 1 };
    const b: VectorClock = { "zone-a": 1, "zone-b": 2 };
    expect(compareClock(a, b)).toBe("concurrent");
  });

  test("treats missing keys as 0", () => {
    expect(compareClock({ "zone-a": 1 }, {})).toBe("after");
    expect(compareClock({}, { "zone-a": 1 })).toBe("before");
  });

  test("handles disjoint key sets", () => {
    const a: VectorClock = { "zone-a": 1 };
    const b: VectorClock = { "zone-b": 1 };
    expect(compareClock(a, b)).toBe("concurrent");
  });
});

describe("isAfterCursor", () => {
  const cursor: SyncCursor = {
    zoneId: zoneId("zone-a"),
    vectorClock: { "zone-a": 5 },
    lastSequence: 5,
    lastSyncAt: 1000,
  };

  test("returns true when event sequence > cursor lastSequence", () => {
    const event: FederationSyncEvent = {
      kind: "test",
      originZoneId: zoneId("zone-a"),
      sequence: 6,
      vectorClock: { "zone-a": 6 },
      data: {},
      emittedAt: 2000,
    };
    expect(isAfterCursor(event, cursor, "zone-a")).toBe(true);
  });

  test("returns false when event sequence <= cursor lastSequence", () => {
    const event: FederationSyncEvent = {
      kind: "test",
      originZoneId: zoneId("zone-a"),
      sequence: 5,
      vectorClock: { "zone-a": 5 },
      data: {},
      emittedAt: 2000,
    };
    expect(isAfterCursor(event, cursor, "zone-a")).toBe(false);
  });

  test("returns false when event is from a different zone", () => {
    const event: FederationSyncEvent = {
      kind: "test",
      originZoneId: zoneId("zone-b"),
      sequence: 10,
      vectorClock: { "zone-b": 10 },
      data: {},
      emittedAt: 2000,
    };
    expect(isAfterCursor(event, cursor, "zone-a")).toBe(false);
  });
});

describe("pruneClock", () => {
  test("removes zones inactive before cutoff", () => {
    const clock: VectorClock = { "zone-a": 5, "zone-b": 3, "zone-c": 1 };
    const lastActive: Record<string, number> = {
      "zone-a": 1000,
      "zone-b": 500,
      "zone-c": 2000,
    };
    const result = pruneClock(clock, lastActive, 800);
    expect(result).toEqual({ "zone-a": 5, "zone-c": 1 });
  });

  test("keeps zones with no activity data (conservative)", () => {
    const clock: VectorClock = { "zone-a": 5, "zone-b": 3 };
    const lastActive: Record<string, number> = { "zone-a": 100 };
    const result = pruneClock(clock, lastActive, 200);
    // zone-a is pruned (100 < 200), zone-b kept (no data)
    expect(result).toEqual({ "zone-b": 3 });
  });

  test("returns empty clock when all zones pruned", () => {
    const clock: VectorClock = { "zone-a": 1 };
    const result = pruneClock(clock, { "zone-a": 50 }, 100);
    expect(result).toEqual({});
  });

  test("does not mutate original clock", () => {
    const clock: VectorClock = { "zone-a": 1 };
    pruneClock(clock, { "zone-a": 50 }, 100);
    expect(clock).toEqual({ "zone-a": 1 });
  });
});
