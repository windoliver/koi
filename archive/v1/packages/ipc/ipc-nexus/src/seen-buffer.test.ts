import { describe, expect, test } from "bun:test";
import { createSeenBuffer } from "./seen-buffer.js";

describe("createSeenBuffer", () => {
  test("has() returns false for unknown IDs", () => {
    const buf = createSeenBuffer(5);
    expect(buf.has("msg-1")).toBe(false);
  });

  test("has() returns true after add()", () => {
    const buf = createSeenBuffer(5);
    buf.add("msg-1");
    expect(buf.has("msg-1")).toBe(true);
  });

  test("tracks multiple IDs", () => {
    const buf = createSeenBuffer(5);
    buf.add("a");
    buf.add("b");
    buf.add("c");
    expect(buf.has("a")).toBe(true);
    expect(buf.has("b")).toBe(true);
    expect(buf.has("c")).toBe(true);
    expect(buf.has("d")).toBe(false);
  });

  test("evicts oldest ID when capacity exceeded", () => {
    const buf = createSeenBuffer(3);
    buf.add("a");
    buf.add("b");
    buf.add("c");
    // Buffer full: [a, b, c]. Next add overwrites slot 0
    buf.add("d");
    expect(buf.has("a")).toBe(false); // evicted
    expect(buf.has("b")).toBe(true);
    expect(buf.has("c")).toBe(true);
    expect(buf.has("d")).toBe(true);
  });

  test("wraps around correctly", () => {
    const buf = createSeenBuffer(2);
    buf.add("a"); // [a, _]
    buf.add("b"); // [a, b]
    buf.add("c"); // [c, b]  — overwrites a
    buf.add("d"); // [c, d]  — overwrites b
    expect(buf.has("a")).toBe(false);
    expect(buf.has("b")).toBe(false);
    expect(buf.has("c")).toBe(true);
    expect(buf.has("d")).toBe(true);
  });

  test("clear() resets all state", () => {
    const buf = createSeenBuffer(5);
    buf.add("a");
    buf.add("b");
    buf.clear();
    expect(buf.has("a")).toBe(false);
    expect(buf.has("b")).toBe(false);
  });

  test("throws on capacity < 1", () => {
    expect(() => createSeenBuffer(0)).toThrow("capacity must be >= 1");
    expect(() => createSeenBuffer(-5)).toThrow("capacity must be >= 1");
  });

  test("add() works correctly after clear()", () => {
    const buf = createSeenBuffer(3);
    buf.add("a");
    buf.add("b");
    buf.clear();
    buf.add("c");
    expect(buf.has("a")).toBe(false);
    expect(buf.has("c")).toBe(true);
  });
});
