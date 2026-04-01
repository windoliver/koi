import { describe, expect, mock, test } from "bun:test";
import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core/rich-trajectory";
import { createAtifWriteBehindBuffer } from "./atif-buffer.js";

const BASE_TIMESTAMP = 1700000000000;

function createStep(index: number): RichTrajectoryStep {
  return {
    stepIndex: index,
    timestamp: BASE_TIMESTAMP + index * 1000,
    source: "agent",
    kind: "model_call",
    identifier: "claude-3-opus",
    outcome: "success",
    durationMs: 1200,
    request: { text: `Step ${index}` },
  };
}

function createMockStore(): TrajectoryDocumentStore & {
  readonly appendCalls: Array<{
    readonly docId: string;
    readonly steps: readonly RichTrajectoryStep[];
  }>;
} {
  const appendCalls: Array<{
    readonly docId: string;
    readonly steps: readonly RichTrajectoryStep[];
  }> = [];

  return {
    appendCalls,
    append: mock(async (docId: string, steps: readonly RichTrajectoryStep[]) => {
      appendCalls.push({ docId, steps });
    }),
    getDocument: mock(async () => []),
    getStepRange: mock(async () => []),
    getSize: mock(async () => 0),
    prune: mock(async () => 0),
  };
}

describe("createAtifWriteBehindBuffer", () => {
  test("append accumulates steps in memory", () => {
    const store = createMockStore();
    const buffer = createAtifWriteBehindBuffer(store, {
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    buffer.append("doc-1", createStep(0));
    buffer.append("doc-1", createStep(1));

    expect(buffer.pending("doc-1")).toBe(2);
    expect(store.appendCalls).toHaveLength(0); // Not flushed yet

    buffer.dispose();
  });

  test("flush drains all pending steps to store", async () => {
    const store = createMockStore();
    const buffer = createAtifWriteBehindBuffer(store, {
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    buffer.append("doc-1", createStep(0));
    buffer.append("doc-1", createStep(1));
    buffer.append("doc-1", createStep(2));

    await buffer.flush();

    expect(buffer.pending("doc-1")).toBe(0);
    expect(store.appendCalls).toHaveLength(1);
    expect(store.appendCalls[0]?.steps).toHaveLength(3);

    buffer.dispose();
  });

  test("flush with docId only flushes that document", async () => {
    const store = createMockStore();
    const buffer = createAtifWriteBehindBuffer(store, {
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    buffer.append("doc-1", createStep(0));
    buffer.append("doc-2", createStep(1));

    await buffer.flush("doc-1");

    expect(buffer.pending("doc-1")).toBe(0);
    expect(buffer.pending("doc-2")).toBe(1);
    expect(store.appendCalls).toHaveLength(1);
    expect(store.appendCalls[0]?.docId).toBe("doc-1");

    buffer.dispose();
  });

  test("auto-flushes when batch size is reached", async () => {
    const store = createMockStore();
    const buffer = createAtifWriteBehindBuffer(store, {
      batchSize: 3,
      flushIntervalMs: 60_000,
    });

    buffer.append("doc-1", createStep(0));
    buffer.append("doc-1", createStep(1));
    buffer.append("doc-1", createStep(2)); // Triggers auto-flush

    // Wait for async flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(store.appendCalls).toHaveLength(1);
    expect(store.appendCalls[0]?.steps).toHaveLength(3);

    buffer.dispose();
  });

  test("pending returns 0 for unknown document", () => {
    const store = createMockStore();
    const buffer = createAtifWriteBehindBuffer(store, { flushIntervalMs: 60_000 });

    expect(buffer.pending("unknown")).toBe(0);

    buffer.dispose();
  });

  test("flush on empty buffer is a no-op", async () => {
    const store = createMockStore();
    const buffer = createAtifWriteBehindBuffer(store, { flushIntervalMs: 60_000 });

    await buffer.flush();

    expect(store.appendCalls).toHaveLength(0);

    buffer.dispose();
  });

  test("calls onFlushError when store.append fails", async () => {
    const errors: unknown[] = [];
    const failingStore: TrajectoryDocumentStore = {
      append: mock(async () => {
        throw new Error("Nexus write failed");
      }),
      getDocument: mock(async () => []),
      getStepRange: mock(async () => []),
      getSize: mock(async () => 0),
      prune: mock(async () => 0),
    };

    const buffer = createAtifWriteBehindBuffer(failingStore, {
      batchSize: 2,
      flushIntervalMs: 60_000,
      onFlushError: (e) => errors.push(e),
    });

    buffer.append("doc-1", createStep(0));
    buffer.append("doc-1", createStep(1)); // Triggers auto-flush

    // Wait for async flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);

    buffer.dispose();
  });
});
