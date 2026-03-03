/**
 * Tests for createFrameDeduplicator — bounded FIFO dedup.
 */

import { describe, expect, test } from "bun:test";
import { createFrameDeduplicator } from "./frame-dedup.js";

describe("FrameDeduplicator", () => {
  test("first occurrence returns false, second returns true", () => {
    const dedup = createFrameDeduplicator();
    expect(dedup.isDuplicate("a")).toBe(false);
    expect(dedup.isDuplicate("a")).toBe(true);
    expect(dedup.isDuplicate("b")).toBe(false);
    expect(dedup.isDuplicate("b")).toBe(true);
  });

  test("evicts oldest entry when maxSize is exceeded", () => {
    const dedup = createFrameDeduplicator(3);

    // Fill to capacity: ring = [a, b, c], head = 0
    expect(dedup.isDuplicate("a")).toBe(false);
    expect(dedup.isDuplicate("b")).toBe(false);
    expect(dedup.isDuplicate("c")).toBe(false);
    expect(dedup.size()).toBe(3);

    // Adding "d" evicts "a" (ring[0]): ring = [d, b, c], head = 1
    expect(dedup.isDuplicate("d")).toBe(false);
    expect(dedup.size()).toBe(3);

    // "a" was evicted — no longer tracked
    expect(dedup.isDuplicate("a")).toBe(false);
    // But that re-insert evicted "b" (ring[1]): ring = [d, a, c], head = 2

    // "d" is still tracked (was inserted and not evicted)
    expect(dedup.isDuplicate("d")).toBe(true);
  });

  test("reset clears all state", () => {
    const dedup = createFrameDeduplicator();
    dedup.isDuplicate("x");
    dedup.isDuplicate("y");
    expect(dedup.size()).toBe(2);

    dedup.reset();
    expect(dedup.size()).toBe(0);

    // Previously seen IDs are no longer duplicates
    expect(dedup.isDuplicate("x")).toBe(false);
    expect(dedup.isDuplicate("y")).toBe(false);
  });

  test("handles empty string IDs", () => {
    const dedup = createFrameDeduplicator();
    expect(dedup.isDuplicate("")).toBe(false);
    expect(dedup.isDuplicate("")).toBe(true);
  });

  test("size tracks current count accurately", () => {
    const dedup = createFrameDeduplicator(5);
    expect(dedup.size()).toBe(0);

    for (let i = 0; i < 5; i++) {
      dedup.isDuplicate(`id-${i}`);
    }
    expect(dedup.size()).toBe(5);

    // Adding more wraps around — size stays at max
    dedup.isDuplicate("overflow");
    expect(dedup.size()).toBe(5);
  });
});
