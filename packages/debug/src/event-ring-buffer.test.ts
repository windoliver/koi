/**
 * Tests for EventRingBuffer — bounded circular buffer for EngineEvent history.
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createEventRingBuffer } from "./event-ring-buffer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurnStartEvent(turnIndex: number): EngineEvent {
  return { kind: "turn_start", turnIndex };
}

function makeTurnEndEvent(turnIndex: number): EngineEvent {
  return { kind: "turn_end", turnIndex };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createEventRingBuffer", () => {
  test("returns empty array when no events have been pushed", () => {
    const buffer = createEventRingBuffer(5);
    expect(buffer.tail()).toEqual([]);
    expect(buffer.size()).toBe(0);
  });

  test("push and tail return events in insertion order", () => {
    const buffer = createEventRingBuffer(5);
    buffer.push(makeTurnStartEvent(0));
    buffer.push(makeTurnEndEvent(0));
    buffer.push(makeTurnStartEvent(1));

    const events = buffer.tail();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ kind: "turn_start", turnIndex: 0 });
    expect(events[1]).toEqual({ kind: "turn_end", turnIndex: 0 });
    expect(events[2]).toEqual({ kind: "turn_start", turnIndex: 1 });
  });

  test("size returns number of events pushed when under capacity", () => {
    const buffer = createEventRingBuffer(10);
    buffer.push(makeTurnStartEvent(0));
    buffer.push(makeTurnEndEvent(0));
    expect(buffer.size()).toBe(2);
  });

  test("capacity returns the configured max size", () => {
    const buffer = createEventRingBuffer(42);
    expect(buffer.capacity()).toBe(42);
  });

  test("overflow wraps around and discards oldest events", () => {
    const buffer = createEventRingBuffer(3);
    buffer.push(makeTurnStartEvent(0));
    buffer.push(makeTurnStartEvent(1));
    buffer.push(makeTurnStartEvent(2));
    buffer.push(makeTurnStartEvent(3)); // overwrites index 0
    buffer.push(makeTurnStartEvent(4)); // overwrites index 1

    expect(buffer.size()).toBe(3);
    const events = buffer.tail();
    expect(events).toHaveLength(3);
    // Oldest surviving event is turn 2
    expect(events[0]).toEqual({ kind: "turn_start", turnIndex: 2 });
    expect(events[1]).toEqual({ kind: "turn_start", turnIndex: 3 });
    expect(events[2]).toEqual({ kind: "turn_start", turnIndex: 4 });
  });

  test("size returns capacity when more events than capacity have been pushed", () => {
    const buffer = createEventRingBuffer(2);
    buffer.push(makeTurnStartEvent(0));
    buffer.push(makeTurnStartEvent(1));
    buffer.push(makeTurnStartEvent(2));
    buffer.push(makeTurnStartEvent(3));
    expect(buffer.size()).toBe(2);
  });

  test("tail with limit returns only the N newest events", () => {
    const buffer = createEventRingBuffer(10);
    buffer.push(makeTurnStartEvent(0));
    buffer.push(makeTurnStartEvent(1));
    buffer.push(makeTurnStartEvent(2));
    buffer.push(makeTurnStartEvent(3));
    buffer.push(makeTurnStartEvent(4));

    const events = buffer.tail(2);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ kind: "turn_start", turnIndex: 3 });
    expect(events[1]).toEqual({ kind: "turn_start", turnIndex: 4 });
  });

  test("tail with limit larger than size returns all events", () => {
    const buffer = createEventRingBuffer(10);
    buffer.push(makeTurnStartEvent(0));
    buffer.push(makeTurnStartEvent(1));

    const events = buffer.tail(100);
    expect(events).toHaveLength(2);
  });

  test("tail with limit after overflow returns newest from wrapped buffer", () => {
    const buffer = createEventRingBuffer(3);
    buffer.push(makeTurnStartEvent(0));
    buffer.push(makeTurnStartEvent(1));
    buffer.push(makeTurnStartEvent(2));
    buffer.push(makeTurnStartEvent(3));
    buffer.push(makeTurnStartEvent(4));

    const events = buffer.tail(2);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ kind: "turn_start", turnIndex: 3 });
    expect(events[1]).toEqual({ kind: "turn_start", turnIndex: 4 });
  });

  test("clear resets size to zero and tail returns empty array", () => {
    const buffer = createEventRingBuffer(5);
    buffer.push(makeTurnStartEvent(0));
    buffer.push(makeTurnStartEvent(1));
    buffer.push(makeTurnStartEvent(2));

    expect(buffer.size()).toBe(3);

    buffer.clear();

    expect(buffer.size()).toBe(0);
    expect(buffer.tail()).toEqual([]);
  });

  test("push works correctly after clear", () => {
    const buffer = createEventRingBuffer(3);
    buffer.push(makeTurnStartEvent(0));
    buffer.push(makeTurnStartEvent(1));
    buffer.clear();

    buffer.push(makeTurnStartEvent(10));
    expect(buffer.size()).toBe(1);
    expect(buffer.tail()).toEqual([{ kind: "turn_start", turnIndex: 10 }]);
  });

  test("single-element buffer works correctly with overflow", () => {
    const buffer = createEventRingBuffer(1);
    buffer.push(makeTurnStartEvent(0));
    expect(buffer.size()).toBe(1);
    expect(buffer.tail()).toEqual([{ kind: "turn_start", turnIndex: 0 }]);

    buffer.push(makeTurnStartEvent(1));
    expect(buffer.size()).toBe(1);
    expect(buffer.tail()).toEqual([{ kind: "turn_start", turnIndex: 1 }]);
  });

  test("tail with limit of zero returns empty array", () => {
    const buffer = createEventRingBuffer(5);
    buffer.push(makeTurnStartEvent(0));
    buffer.push(makeTurnStartEvent(1));

    const events = buffer.tail(0);
    expect(events).toHaveLength(0);
  });
});
