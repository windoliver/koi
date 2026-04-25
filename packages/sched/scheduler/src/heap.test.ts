import { describe, expect, it } from "bun:test";
import { createHeap } from "./heap.js";

describe("createHeap", () => {
  const numCmp = (a: number, b: number) => a - b;

  it("extracts items in ascending order", () => {
    const h = createHeap(numCmp);
    h.insert(3);
    h.insert(1);
    h.insert(2);
    expect(h.extractMin()).toBe(1);
    expect(h.extractMin()).toBe(2);
    expect(h.extractMin()).toBe(3);
  });

  it("peek does not remove", () => {
    const h = createHeap(numCmp);
    h.insert(5);
    expect(h.peek()).toBe(5);
    expect(h.size()).toBe(1);
  });

  it("returns undefined when empty", () => {
    const h = createHeap(numCmp);
    expect(h.extractMin()).toBeUndefined();
    expect(h.peek()).toBeUndefined();
  });

  it("remove by predicate", () => {
    const h = createHeap(numCmp);
    h.insert(1);
    h.insert(3);
    h.insert(2);
    expect(h.remove((x) => x === 3)).toBe(true);
    expect(h.toArray().includes(3)).toBe(false);
    expect(h.size()).toBe(2);
  });

  it("remove returns false when not found", () => {
    const h = createHeap(numCmp);
    h.insert(1);
    expect(h.remove((x) => x === 99)).toBe(false);
  });
});
