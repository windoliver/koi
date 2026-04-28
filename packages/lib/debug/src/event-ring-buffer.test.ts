import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createEventRingBuffer } from "./event-ring-buffer.js";

function makeEvent(turnIndex: number): EngineEvent {
  return { kind: "turn_start", turnIndex };
}

describe("createEventRingBuffer", () => {
  test("starts empty", () => {
    const buf = createEventRingBuffer(5);
    expect(buf.size()).toBe(0);
    expect(buf.capacity()).toBe(5);
    expect(buf.tail()).toEqual([]);
  });

  test("push and tail returns events oldest first", () => {
    const buf = createEventRingBuffer(5);
    buf.push(makeEvent(0));
    buf.push(makeEvent(1));
    buf.push(makeEvent(2));

    const events = buf.tail();
    expect(events).toHaveLength(3);
    expect((events[0] as Extract<EngineEvent, { kind: "turn_start" }>).turnIndex).toBe(0);
    expect((events[2] as Extract<EngineEvent, { kind: "turn_start" }>).turnIndex).toBe(2);
  });

  test("tail with limit returns most recent N events", () => {
    const buf = createEventRingBuffer(10);
    for (let i = 0; i < 5; i++) buf.push(makeEvent(i));

    const events = buf.tail(3);
    expect(events).toHaveLength(3);
    expect((events[0] as Extract<EngineEvent, { kind: "turn_start" }>).turnIndex).toBe(2);
    expect((events[2] as Extract<EngineEvent, { kind: "turn_start" }>).turnIndex).toBe(4);
  });

  test("overwrites oldest when full", () => {
    const buf = createEventRingBuffer(3);
    buf.push(makeEvent(0));
    buf.push(makeEvent(1));
    buf.push(makeEvent(2));
    buf.push(makeEvent(3)); // evicts event 0

    expect(buf.size()).toBe(3);
    const events = buf.tail();
    expect((events[0] as Extract<EngineEvent, { kind: "turn_start" }>).turnIndex).toBe(1);
    expect((events[2] as Extract<EngineEvent, { kind: "turn_start" }>).turnIndex).toBe(3);
  });

  test("clear empties the buffer", () => {
    const buf = createEventRingBuffer(5);
    buf.push(makeEvent(0));
    buf.push(makeEvent(1));
    buf.clear();

    expect(buf.size()).toBe(0);
    expect(buf.tail()).toEqual([]);
  });

  test("tail limit larger than size returns all events", () => {
    const buf = createEventRingBuffer(10);
    buf.push(makeEvent(0));
    buf.push(makeEvent(1));

    expect(buf.tail(100)).toHaveLength(2);
  });

  test("size never exceeds capacity", () => {
    const buf = createEventRingBuffer(3);
    for (let i = 0; i < 10; i++) buf.push(makeEvent(i));
    expect(buf.size()).toBe(3);
  });
});
