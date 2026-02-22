import { describe, expect, test } from "bun:test";
import { createMinHeap } from "../heap.js";

const numCompare = (a: number, b: number): number => a - b;

describe("MinHeap", () => {
  test("insert maintains heap property — extractMin returns smallest", () => {
    const heap = createMinHeap<number>(numCompare);
    heap.insert(5);
    heap.insert(3);
    heap.insert(7);
    heap.insert(1);

    expect(heap.extractMin()).toBe(1);
    expect(heap.extractMin()).toBe(3);
    expect(heap.extractMin()).toBe(5);
    expect(heap.extractMin()).toBe(7);
  });

  test("peek returns smallest without removing", () => {
    const heap = createMinHeap<number>(numCompare);
    heap.insert(10);
    heap.insert(2);

    expect(heap.peek()).toBe(2);
    expect(heap.size()).toBe(2);
    expect(heap.peek()).toBe(2);
  });

  test("empty heap returns undefined for peek and extractMin", () => {
    const heap = createMinHeap<number>(numCompare);

    expect(heap.peek()).toBeUndefined();
    expect(heap.extractMin()).toBeUndefined();
  });

  test("size tracks insertions and extractions", () => {
    const heap = createMinHeap<number>(numCompare);
    expect(heap.size()).toBe(0);

    heap.insert(1);
    heap.insert(2);
    expect(heap.size()).toBe(2);

    heap.extractMin();
    expect(heap.size()).toBe(1);
  });

  test("toArray returns copy of internal data", () => {
    const heap = createMinHeap<number>(numCompare);
    heap.insert(3);
    heap.insert(1);
    heap.insert(2);

    const arr = heap.toArray();
    expect(arr.length).toBe(3);
    // Should contain all elements (heap order, not sorted)
    expect(arr).toContain(1);
    expect(arr).toContain(2);
    expect(arr).toContain(3);
  });

  test("stability: equal-priority items extracted in insertion order", () => {
    const heap = createMinHeap<{ readonly p: number; readonly seq: number }>((a, b) => {
      const pd = a.p - b.p;
      if (pd !== 0) return pd;
      return a.seq - b.seq;
    });

    heap.insert({ p: 1, seq: 0 });
    heap.insert({ p: 1, seq: 1 });
    heap.insert({ p: 1, seq: 2 });

    expect(heap.extractMin()?.seq).toBe(0);
    expect(heap.extractMin()?.seq).toBe(1);
    expect(heap.extractMin()?.seq).toBe(2);
  });

  test("large insert/extract sequence (100 items)", () => {
    const heap = createMinHeap<number>(numCompare);
    const input = Array.from({ length: 100 }, (_, i) => 100 - i);

    for (const n of input) {
      heap.insert(n);
    }

    const output: number[] = [];
    while (heap.size() > 0) {
      const val = heap.extractMin();
      if (val !== undefined) output.push(val);
    }

    // Should be sorted ascending
    for (let i = 1; i < output.length; i++) {
      expect(output[i]).toBeGreaterThanOrEqual(output[i - 1] ?? 0);
    }
    expect(output.length).toBe(100);
    expect(output[0]).toBe(1);
    expect(output[99]).toBe(100);
  });

  test("remove deletes matching element", () => {
    const heap = createMinHeap<number>(numCompare);
    heap.insert(5);
    heap.insert(3);
    heap.insert(7);

    const removed = heap.remove((n) => n === 3);
    expect(removed).toBe(true);
    expect(heap.size()).toBe(2);
    expect(heap.extractMin()).toBe(5);
    expect(heap.extractMin()).toBe(7);
  });

  test("remove returns false when element not found", () => {
    const heap = createMinHeap<number>(numCompare);
    heap.insert(1);
    heap.insert(2);

    expect(heap.remove((n) => n === 99)).toBe(false);
    expect(heap.size()).toBe(2);
  });

  test("extractMin from single-element heap", () => {
    const heap = createMinHeap<number>(numCompare);
    heap.insert(42);
    expect(heap.extractMin()).toBe(42);
    expect(heap.size()).toBe(0);
  });
});
