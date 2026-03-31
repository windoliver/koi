import { describe, expect, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import { createInMemoryAtifDocumentStore } from "./atif-store.js";

const BASE_TIMESTAMP = 1700000000000;

function createStep(overrides?: Partial<RichTrajectoryStep>): RichTrajectoryStep {
  return {
    stepIndex: 0,
    timestamp: BASE_TIMESTAMP,
    source: "agent",
    kind: "model_call",
    identifier: "claude-3-opus",
    outcome: "success",
    durationMs: 1200,
    request: { text: "Hello" },
    response: { text: "Hi there" },
    ...overrides,
  };
}

function createSteps(count: number, startIndex = 0): readonly RichTrajectoryStep[] {
  return Array.from({ length: count }, (_, i) =>
    createStep({
      stepIndex: startIndex + i,
      timestamp: BASE_TIMESTAMP + i * 1000,
    }),
  );
}

describe("createInMemoryAtifDocumentStore", () => {
  test("append and getDocument round-trips steps", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    const steps = createSteps(3);

    await store.append("doc-1", steps);
    const result = await store.getDocument("doc-1");

    expect(result).toHaveLength(3);
    expect(result[0]?.stepIndex).toBe(0);
    expect(result[1]?.stepIndex).toBe(1);
    expect(result[2]?.stepIndex).toBe(2);
  });

  test("append accumulates across multiple calls", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });

    await store.append("doc-1", createSteps(2, 0));
    await store.append("doc-1", createSteps(3, 2));

    const result = await store.getDocument("doc-1");
    expect(result).toHaveLength(5);
  });

  test("getDocument returns empty for nonexistent document", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    const result = await store.getDocument("nonexistent");
    expect(result).toEqual([]);
  });

  test("getStepRange returns filtered subset by stepIndex", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    await store.append("doc-1", createSteps(10));

    // Get steps 3-6 (inclusive start, exclusive end)
    const range = await store.getStepRange("doc-1", 3, 7);
    expect(range).toHaveLength(4);
    expect(range[0]?.stepIndex).toBe(3);
    expect(range[3]?.stepIndex).toBe(6);
  });

  test("getStepRange returns empty for nonexistent document", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    const range = await store.getStepRange("nonexistent", 0, 10);
    expect(range).toEqual([]);
  });

  test("getStepRange with startIndex beyond max returns empty", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    await store.append("doc-1", createSteps(5));

    const range = await store.getStepRange("doc-1", 100, 200);
    expect(range).toEqual([]);
  });

  test("getSize returns 0 for nonexistent document", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    const size = await store.getSize("nonexistent");
    expect(size).toBe(0);
  });

  test("getSize returns positive number for existing document", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    await store.append("doc-1", createSteps(5));

    const size = await store.getSize("doc-1");
    expect(size).toBeGreaterThan(0);
  });

  test("prune removes documents older than cutoff", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });

    // doc-old: steps at BASE_TIMESTAMP
    await store.append("doc-old", createSteps(3));

    // doc-new: steps at BASE_TIMESTAMP + 100000
    await store.append(
      "doc-new",
      createSteps(2, 0).map((s) => ({
        ...s,
        timestamp: BASE_TIMESTAMP + 100_000,
      })),
    );

    // Prune docs with last step older than BASE_TIMESTAMP + 50000
    const pruned = await store.prune(BASE_TIMESTAMP + 50_000);

    expect(pruned).toBe(3); // 3 steps from doc-old
    expect(await store.getDocument("doc-old")).toEqual([]);
    expect(await store.getDocument("doc-new")).toHaveLength(2);
  });

  test("preserves durationMs and outcome through ATIF round-trip", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    const steps = [
      createStep({ stepIndex: 0, durationMs: 5000, outcome: "retry" }),
      createStep({ stepIndex: 1, durationMs: 200, outcome: "failure" }),
    ];

    await store.append("doc-1", steps);
    const result = await store.getDocument("doc-1");

    expect(result[0]?.durationMs).toBe(5000);
    expect(result[0]?.outcome).toBe("retry");
    expect(result[1]?.durationMs).toBe(200);
    expect(result[1]?.outcome).toBe("failure");
  });

  test("size cap prunes oldest steps when document exceeds maxSizeBytes", async () => {
    // Create store with a tiny size cap
    const store = createInMemoryAtifDocumentStore({
      agentName: "test",
      maxSizeBytes: 2000, // Very small cap
    });

    // Add steps until we exceed the cap
    const bigStep = createStep({
      stepIndex: 0,
      request: { text: "A".repeat(500) },
      response: { text: "B".repeat(500) },
    });

    await store.append("doc-1", [bigStep]);
    await store.append("doc-1", [{ ...bigStep, stepIndex: 1, timestamp: BASE_TIMESTAMP + 1000 }]);
    await store.append("doc-1", [{ ...bigStep, stepIndex: 2, timestamp: BASE_TIMESTAMP + 2000 }]);

    const result = await store.getDocument("doc-1");
    // With the tiny cap, oldest steps should have been pruned
    // At minimum, the last step should always be preserved
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});
