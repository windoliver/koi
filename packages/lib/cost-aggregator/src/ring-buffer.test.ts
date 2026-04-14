import { describe, expect, test } from "bun:test";
import { createRingBuffer } from "./ring-buffer.js";

describe("createRingBuffer", () => {
  test("empty buffer returns empty array", () => {
    const buf = createRingBuffer<number>(5);
    expect(buf.toArray()).toEqual([]);
    expect(buf.size()).toBe(0);
  });

  test("push and retrieve within capacity", () => {
    const buf = createRingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
    expect(buf.size()).toBe(3);
  });

  test("wraps around when capacity exceeded", () => {
    const buf = createRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // evicts 1
    expect(buf.toArray()).toEqual([2, 3, 4]);
    expect(buf.size()).toBe(3);
  });

  test("multiple wraps preserve order", () => {
    const buf = createRingBuffer<number>(3);
    for (let i = 1; i <= 10; i++) {
      buf.push(i);
    }
    expect(buf.toArray()).toEqual([8, 9, 10]);
  });

  test("clear resets buffer", () => {
    const buf = createRingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.toArray()).toEqual([]);
    expect(buf.size()).toBe(0);
  });

  test("push after clear works", () => {
    const buf = createRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.clear();
    buf.push(10);
    expect(buf.toArray()).toEqual([10]);
    expect(buf.size()).toBe(1);
  });

  test("capacity of 1 keeps only latest", () => {
    const buf = createRingBuffer<string>(1);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    expect(buf.toArray()).toEqual(["c"]);
    expect(buf.size()).toBe(1);
  });

  test("exactly at capacity", () => {
    const buf = createRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
    expect(buf.size()).toBe(3);
  });
});
