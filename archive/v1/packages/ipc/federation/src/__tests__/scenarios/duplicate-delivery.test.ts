/**
 * Scenario: Same batch fetched twice — deduplicateEvents filters all dupes.
 */
import { describe, expect, test } from "bun:test";
import { advanceCursor, deduplicateEvents } from "../../sync-protocol.js";
import { createInitialCursor, createTestEvent } from "../harness.js";

describe("duplicate delivery", () => {
  test("deduplicateEvents filters all events already seen", () => {
    const cursor = createInitialCursor("zone-a");
    const batch = [
      createTestEvent("zone-a", 1),
      createTestEvent("zone-a", 2),
      createTestEvent("zone-a", 3),
    ];

    // First pass: all events are new
    const first = deduplicateEvents(batch, cursor);
    expect(first).toHaveLength(3);

    // Advance cursor
    const updatedCursor = advanceCursor(cursor, first);
    expect(updatedCursor.lastSequence).toBe(3);

    // Second pass: same batch, all should be filtered
    const second = deduplicateEvents(batch, updatedCursor);
    expect(second).toHaveLength(0);
  });

  test("partial overlap keeps only new events", () => {
    const cursor = createInitialCursor("zone-a");
    const batch1 = [createTestEvent("zone-a", 1), createTestEvent("zone-a", 2)];

    const first = deduplicateEvents(batch1, cursor);
    const updatedCursor = advanceCursor(cursor, first);

    // Overlapping batch with one new event
    const batch2 = [createTestEvent("zone-a", 2), createTestEvent("zone-a", 3)];
    const second = deduplicateEvents(batch2, updatedCursor);
    expect(second).toHaveLength(1);
    expect(second[0]?.sequence).toBe(3);
  });
});
