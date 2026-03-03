import { describe, expect, test } from "bun:test";
import { brickId } from "@koi/core";
import { createTestToolArtifact } from "@koi/test-utils";
import type { ReverificationConfig } from "./reverification.js";
import { DEFAULT_REVERIFICATION_CONFIG } from "./reverification.js";
import type { ReverificationHandler } from "./reverification-queue.js";
import { createReverificationQueue } from "./reverification-queue.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configWith(overrides?: Partial<ReverificationConfig>): ReverificationConfig {
  return { ...DEFAULT_REVERIFICATION_CONFIG, ...overrides };
}

/** Creates a handler that collects processed brick IDs and resolves via callbacks. */
function createTrackingHandler(): {
  readonly handler: ReverificationHandler;
  readonly processed: string[];
  readonly resolvers: Array<(value: boolean) => void>;
} {
  const processed: string[] = [];
  const resolvers: Array<(value: boolean) => void> = [];
  const handler: ReverificationHandler = (brick) =>
    new Promise<boolean>((resolve) => {
      processed.push(brick.id);
      resolvers.push(resolve);
    });
  return { handler, processed, resolvers };
}

// ---------------------------------------------------------------------------
// createReverificationQueue
// ---------------------------------------------------------------------------

describe("createReverificationQueue", () => {
  test("enqueues and processes one brick", async () => {
    const { handler, processed, resolvers } = createTrackingHandler();
    const queue = createReverificationQueue(configWith(), handler);

    const brick = createTestToolArtifact({
      id: brickId("brick_a"),
      trustTier: "verified",
    });
    const accepted = queue.enqueue(brick);

    expect(accepted).toBe(true);
    expect(queue.activeCount()).toBe(1);
    expect(processed).toEqual(["brick_a"]);

    // Complete the handler
    resolvers[0]?.(true);
    // Let microtask flush
    await Promise.resolve();

    expect(queue.activeCount()).toBe(0);
  });

  test("deduplicates: same brick not enqueued twice", () => {
    const { handler } = createTrackingHandler();
    const queue = createReverificationQueue(configWith(), handler);

    const brick = createTestToolArtifact({
      id: brickId("brick_dup"),
      trustTier: "verified",
    });
    expect(queue.enqueue(brick)).toBe(true);
    expect(queue.enqueue(brick)).toBe(false);
  });

  test("rejects sandbox bricks", () => {
    const { handler } = createTrackingHandler();
    const queue = createReverificationQueue(configWith(), handler);

    const brick = createTestToolArtifact({
      id: brickId("brick_sandbox"),
      trustTier: "sandbox",
    });
    expect(queue.enqueue(brick)).toBe(false);
    expect(queue.activeCount()).toBe(0);
    expect(queue.pendingCount()).toBe(0);
  });

  test("accepts both verified and promoted bricks", () => {
    const { handler } = createTrackingHandler();
    const config = configWith({ maxConcurrency: 3 });
    const queue = createReverificationQueue(config, handler);

    const verified = createTestToolArtifact({
      id: brickId("brick_v"),
      trustTier: "verified",
    });
    const promoted = createTestToolArtifact({
      id: brickId("brick_p"),
      trustTier: "promoted",
    });

    expect(queue.enqueue(verified)).toBe(true);
    expect(queue.enqueue(promoted)).toBe(true);
    expect(queue.activeCount()).toBe(2);
  });

  test("bounded concurrency: no more than maxConcurrency in-flight", () => {
    const { handler } = createTrackingHandler();
    const config = configWith({ maxConcurrency: 2 });
    const queue = createReverificationQueue(config, handler);

    const a = createTestToolArtifact({ id: brickId("brick_1"), trustTier: "verified" });
    const b = createTestToolArtifact({ id: brickId("brick_2"), trustTier: "verified" });
    const c = createTestToolArtifact({ id: brickId("brick_3"), trustTier: "verified" });

    queue.enqueue(a);
    queue.enqueue(b);
    queue.enqueue(c);

    expect(queue.activeCount()).toBe(2);
    expect(queue.pendingCount()).toBe(1);
  });

  test("FIFO ordering: bricks processed in enqueue order", async () => {
    const { handler, processed, resolvers } = createTrackingHandler();
    const config = configWith({ maxConcurrency: 1 });
    const queue = createReverificationQueue(config, handler);

    // Enqueue a promoted brick first, then verified — FIFO means promoted first
    const promoted = createTestToolArtifact({
      id: brickId("brick_p"),
      trustTier: "promoted",
    });
    const verified = createTestToolArtifact({
      id: brickId("brick_v"),
      trustTier: "verified",
    });
    const verified2 = createTestToolArtifact({
      id: brickId("brick_v2"),
      trustTier: "verified",
    });

    // First enqueue immediately starts processing (slot open)
    queue.enqueue(promoted);
    expect(queue.activeCount()).toBe(1);
    expect(processed).toEqual(["brick_p"]);

    // Now enqueue two more — go to pending (FIFO order)
    queue.enqueue(verified);
    queue.enqueue(verified2);
    expect(queue.pendingCount()).toBe(2);

    // Complete first brick — drain picks next in FIFO order
    resolvers[0]?.(true);
    await Promise.resolve();

    // verified was enqueued before verified2, so it should be next
    expect(processed[1]).toBe("brick_v");

    // Complete second
    resolvers[1]?.(true);
    await Promise.resolve();

    expect(processed[2]).toBe("brick_v2");
  });

  test("dispose clears pending items", () => {
    const { handler } = createTrackingHandler();
    const config = configWith({ maxConcurrency: 1 });
    const queue = createReverificationQueue(config, handler);

    const a = createTestToolArtifact({ id: brickId("brick_x"), trustTier: "verified" });
    const b = createTestToolArtifact({ id: brickId("brick_y"), trustTier: "verified" });

    queue.enqueue(a);
    queue.enqueue(b);

    expect(queue.pendingCount()).toBe(1);

    queue.dispose();

    expect(queue.pendingCount()).toBe(0);
    // Should reject new enqueues after dispose
    const c = createTestToolArtifact({ id: brickId("brick_z"), trustTier: "verified" });
    expect(queue.enqueue(c)).toBe(false);
  });
});
