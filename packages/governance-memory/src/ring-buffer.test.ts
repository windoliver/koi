/**
 * Tests for the ring buffer — fixed capacity, oldest eviction.
 */

import { describe, expect, test } from "bun:test";
import { createRingBuffer } from "./ring-buffer.js";

describe("createRingBuffer", () => {
  test("empty buffer — size 0, items empty", () => {
    const buf = createRingBuffer<number>(5);
    expect(buf.size()).toBe(0);
    expect(buf.items()).toEqual([]);
  });

  test("append within capacity", () => {
    const buf = createRingBuffer<number>(3);
    buf.append(1);
    buf.append(2);
    expect(buf.size()).toBe(2);
    expect(buf.items()).toEqual([1, 2]);
  });

  test("append at capacity — oldest evicted", () => {
    const buf = createRingBuffer<number>(3);
    buf.append(1);
    buf.append(2);
    buf.append(3);
    buf.append(4); // Evicts 1
    expect(buf.size()).toBe(3);
    expect(buf.items()).toEqual([2, 3, 4]);
  });

  test("wrap-around — multiple evictions maintain order", () => {
    const buf = createRingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      buf.append(n);
    }
    expect(buf.items()).toEqual([5, 6, 7]);
  });

  test("capacity 1 — only keeps latest", () => {
    const buf = createRingBuffer<string>(1);
    buf.append("a");
    buf.append("b");
    buf.append("c");
    expect(buf.size()).toBe(1);
    expect(buf.items()).toEqual(["c"]);
  });

  test("clear — resets to empty", () => {
    const buf = createRingBuffer<number>(5);
    buf.append(1);
    buf.append(2);
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.items()).toEqual([]);
  });

  test("items returns a snapshot (not a reference to internal state)", () => {
    const buf = createRingBuffer<number>(5);
    buf.append(1);
    const snapshot = buf.items();
    buf.append(2);
    expect(snapshot).toEqual([1]); // Snapshot not affected by subsequent append
  });
});
