import { beforeEach, describe, expect, test } from "bun:test";
import type { ReconcileQueue } from "./reconcile-queue.js";
import { createReconcileQueue } from "./reconcile-queue.js";

describe("createReconcileQueue", () => {
  let queue: ReconcileQueue<string>;

  beforeEach(() => {
    queue = createReconcileQueue<string>();
  });

  // Invariant 1: Enqueue deduplication
  test("deduplicates enqueue for same key already in queue", () => {
    queue.enqueue("a");
    queue.enqueue("a");
    expect(queue.size()).toBe(1);
  });

  // Invariant 2: Dirty set buffering (enqueue during processing)
  test("buffers as dirty when key is in processing", () => {
    queue.enqueue("a");
    queue.dequeue(); // "a" moves to processing
    queue.enqueue("a"); // should go to dirty, not queue
    expect(queue.size()).toBe(1); // only in processing, dirty is a buffer
    expect(queue.has("a")).toBe(true);
  });

  // Invariant 3: Dirty→queue on complete
  test("moves dirty key to queue tail on complete", () => {
    queue.enqueue("a");
    queue.enqueue("b");
    queue.dequeue(); // "a" in processing
    queue.enqueue("a"); // "a" goes to dirty
    queue.complete("a"); // "a" moves from dirty → queue tail
    // Queue should now be: ["b", "a"]
    expect(queue.size()).toBe(2);
    const first = queue.dequeue();
    expect(first).toBe("b");
    const second = queue.dequeue();
    expect(second).toBe("a");
  });

  // Invariant 4: Complete clean key (no dirty)
  test("removes from processing without re-enqueue when not dirty", () => {
    queue.enqueue("a");
    queue.dequeue(); // "a" in processing
    queue.complete("a"); // not dirty, so just remove from processing
    expect(queue.size()).toBe(0);
    expect(queue.has("a")).toBe(false);
  });

  // Invariant 5: Empty queue dequeue
  test("returns undefined when queue is empty", () => {
    expect(queue.dequeue()).toBeUndefined();
  });

  // Invariant 6: FIFO ordering for different keys
  test("maintains FIFO order for different keys", () => {
    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");
    expect(queue.dequeue()).toBe("a");
    expect(queue.dequeue()).toBe("b");
    expect(queue.dequeue()).toBe("c");
  });

  // Invariant 7: Size tracking (pending + processing)
  test("tracks size as pending + processing count", () => {
    expect(queue.size()).toBe(0);
    queue.enqueue("a");
    queue.enqueue("b");
    expect(queue.size()).toBe(2); // 2 pending
    queue.dequeue(); // 1 pending + 1 processing
    expect(queue.size()).toBe(2);
    queue.complete("a"); // 1 pending + 0 processing
    expect(queue.size()).toBe(1);
  });

  // Invariant 8: has() reflects all states (pending, processing, dirty)
  test("has() returns true for pending, processing, and dirty keys", () => {
    expect(queue.has("a")).toBe(false);

    queue.enqueue("a");
    expect(queue.has("a")).toBe(true); // pending

    queue.dequeue();
    expect(queue.has("a")).toBe(true); // processing

    queue.enqueue("a"); // goes to dirty
    expect(queue.has("a")).toBe(true); // dirty + processing

    queue.complete("a"); // dirty → queue
    expect(queue.has("a")).toBe(true); // back in queue
  });

  // Additional: remove() cleans all data structures
  test("remove() clears key from queue, processing, and dirty", () => {
    queue.enqueue("a");
    queue.remove("a");
    expect(queue.has("a")).toBe(false);
    expect(queue.size()).toBe(0);
  });

  test("remove() clears key from processing", () => {
    queue.enqueue("a");
    queue.dequeue();
    queue.enqueue("a"); // dirty
    queue.remove("a");
    expect(queue.has("a")).toBe(false);
  });

  // Additional: clear() resets everything
  test("clear() empties all data structures", () => {
    queue.enqueue("a");
    queue.enqueue("b");
    queue.dequeue(); // "a" processing
    queue.enqueue("a"); // "a" dirty
    queue.clear();
    expect(queue.size()).toBe(0);
    expect(queue.has("a")).toBe(false);
    expect(queue.has("b")).toBe(false);
  });
});
