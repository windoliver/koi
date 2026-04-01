import { afterEach, describe, expect, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core";
import { createWriteBehindBuffer } from "./atif-buffer.js";
import { createInMemoryTrajectoryStore } from "./atif-store.js";

function makeStep(index: number): RichTrajectoryStep {
  return {
    stepIndex: index,
    timestamp: Date.now(),
    source: "agent",
    kind: "model_call",
    identifier: "test-model",
    outcome: "success",
    durationMs: 100,
  };
}

describe("createWriteBehindBuffer", () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  test("append queues without blocking", () => {
    const store = createInMemoryTrajectoryStore();
    const buffer = createWriteBehindBuffer(store, { batchSize: 10, flushIntervalMs: 600_000 });
    dispose = buffer.dispose;

    buffer.append("doc-1", makeStep(0));
    buffer.append("doc-1", makeStep(1));
    expect(buffer.pending("doc-1")).toBe(2);
  });

  test("auto-flush at batch size", async () => {
    const store = createInMemoryTrajectoryStore();
    const buffer = createWriteBehindBuffer(store, { batchSize: 3, flushIntervalMs: 600_000 });
    dispose = buffer.dispose;

    buffer.append("doc-1", makeStep(0));
    buffer.append("doc-1", makeStep(1));
    buffer.append("doc-1", makeStep(2)); // triggers flush

    // Give the async flush a tick to complete
    await new Promise((r) => setTimeout(r, 10));

    const steps = await store.getDocument("doc-1");
    expect(steps).toHaveLength(3);
    expect(buffer.pending("doc-1")).toBe(0);
  });

  test("explicit flush writes all pending", async () => {
    const store = createInMemoryTrajectoryStore();
    const buffer = createWriteBehindBuffer(store, { batchSize: 100, flushIntervalMs: 600_000 });
    dispose = buffer.dispose;

    buffer.append("doc-1", makeStep(0));
    buffer.append("doc-2", makeStep(0));
    await buffer.flush();

    expect(await store.getDocument("doc-1")).toHaveLength(1);
    expect(await store.getDocument("doc-2")).toHaveLength(1);
    expect(buffer.pending("doc-1")).toBe(0);
    expect(buffer.pending("doc-2")).toBe(0);
  });

  test("flush single doc", async () => {
    const store = createInMemoryTrajectoryStore();
    const buffer = createWriteBehindBuffer(store, { batchSize: 100, flushIntervalMs: 600_000 });
    dispose = buffer.dispose;

    buffer.append("doc-1", makeStep(0));
    buffer.append("doc-2", makeStep(0));
    await buffer.flush("doc-1");

    expect(await store.getDocument("doc-1")).toHaveLength(1);
    expect(buffer.pending("doc-2")).toBe(1);
  });

  test("error callback receives flush errors", async () => {
    const errors: Array<{ error: unknown; docId: string }> = [];
    const failingStore = createInMemoryTrajectoryStore();
    // Override append to throw
    (failingStore as { append: typeof failingStore.append }).append = async () => {
      throw new Error("write failed");
    };

    const buffer = createWriteBehindBuffer(failingStore, {
      batchSize: 100,
      flushIntervalMs: 600_000,
      onFlushError: (error, docId) => errors.push({ error, docId }),
    });
    dispose = buffer.dispose;

    buffer.append("doc-1", makeStep(0));
    await buffer.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.docId).toBe("doc-1");
  });

  test("pending returns 0 for unknown doc", () => {
    const store = createInMemoryTrajectoryStore();
    const buffer = createWriteBehindBuffer(store, { flushIntervalMs: 600_000 });
    dispose = buffer.dispose;

    expect(buffer.pending("unknown")).toBe(0);
  });
});
