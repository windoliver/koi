/**
 * Scenario: Events arrive out of order [3, 1, 2] — only events > cursor processed.
 */
import { describe, expect, test } from "bun:test";
import { deduplicateEvents } from "../../sync-protocol.js";
import { createInitialCursor, createTestEvent } from "../harness.js";

describe("out-of-order events", () => {
  test("only events with sequence > cursor.lastSequence are processed", () => {
    const cursor = createInitialCursor("zone-a");

    // Events arrive out of order
    const events = [
      createTestEvent("zone-a", 3),
      createTestEvent("zone-a", 1),
      createTestEvent("zone-a", 2),
    ];

    // All should be included (cursor.lastSequence = 0)
    const result = deduplicateEvents(events, cursor);
    expect(result).toHaveLength(3);
  });

  test("after processing seq 3, events 1 and 2 are filtered", () => {
    // Simulate: cursor already at sequence 3
    const cursor = createInitialCursor("zone-a");
    const advanced = { ...cursor, lastSequence: 3 };

    const lateEvents = [
      createTestEvent("zone-a", 1),
      createTestEvent("zone-a", 2),
      createTestEvent("zone-a", 4), // only this is new
    ];

    const result = deduplicateEvents(lateEvents, advanced);
    expect(result).toHaveLength(1);
    expect(result[0]?.sequence).toBe(4);
  });
});
