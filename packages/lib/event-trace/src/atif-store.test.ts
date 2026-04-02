import { describe, expect, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import type { AtifDocumentDelegate } from "./atif-store.js";
import {
  createAtifDocumentStore,
  createInMemoryAtifDelegate,
  createInMemoryAtifDocumentStore,
} from "./atif-store.js";

function makeStep(stepIndex: number, source: "agent" | "tool" = "agent"): RichTrajectoryStep {
  return {
    stepIndex,
    timestamp: 1700000000000 + stepIndex * 1000,
    source,
    kind: source === "agent" ? "model_call" : "tool_call",
    identifier: source === "agent" ? "claude" : "web_search",
    outcome: "success",
    durationMs: 500,
    request: { text: `Request ${String(stepIndex)}` },
    response: { text: `Response ${String(stepIndex)}` },
  };
}

describe("createInMemoryAtifDocumentStore", () => {
  test("append and retrieve steps", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    await store.append("doc-1", [makeStep(0), makeStep(1)]);

    const steps = await store.getDocument("doc-1");
    expect(steps).toHaveLength(2);
    expect(steps[0]?.stepIndex).toBe(0);
    expect(steps[1]?.stepIndex).toBe(1);
  });

  test("appends to existing document", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    await store.append("doc-1", [makeStep(0)]);
    await store.append("doc-1", [makeStep(1)]);

    const steps = await store.getDocument("doc-1");
    expect(steps).toHaveLength(2);
  });

  test("returns empty array for missing document", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    const steps = await store.getDocument("nonexistent");
    expect(steps).toEqual([]);
  });

  test("ignores empty steps array", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    await store.append("doc-1", []);
    const steps = await store.getDocument("doc-1");
    expect(steps).toEqual([]);
  });

  test("getStepRange returns inclusive start, exclusive end", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    await store.append("doc-1", [makeStep(0), makeStep(1), makeStep(2), makeStep(3)]);

    const range = await store.getStepRange("doc-1", 1, 3);
    expect(range).toHaveLength(2);
    expect(range[0]?.stepIndex).toBe(1);
    expect(range[1]?.stepIndex).toBe(2);
  });

  test("getStepRange returns empty for missing doc", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    const range = await store.getStepRange("nonexistent", 0, 10);
    expect(range).toEqual([]);
  });

  test("getSize returns 0 for missing doc", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    expect(await store.getSize("nonexistent")).toBe(0);
  });

  test("getSize returns positive for existing doc", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    await store.append("doc-1", [makeStep(0)]);
    const size = await store.getSize("doc-1");
    expect(size).toBeGreaterThan(0);
  });
});

describe("maxSteps eviction", () => {
  test("evicts oldest steps when exceeding maxSteps", async () => {
    const store = createInMemoryAtifDocumentStore({
      agentName: "test",
      maxSteps: 3,
    });

    await store.append("doc-1", [makeStep(0), makeStep(1), makeStep(2), makeStep(3), makeStep(4)]);

    const steps = await store.getDocument("doc-1");
    expect(steps).toHaveLength(3);
    // Should keep the 3 newest
    expect(steps[0]?.stepIndex).toBe(2);
    expect(steps[1]?.stepIndex).toBe(3);
    expect(steps[2]?.stepIndex).toBe(4);
  });

  test("does not evict when under maxSteps", async () => {
    const store = createInMemoryAtifDocumentStore({
      agentName: "test",
      maxSteps: 10,
    });

    await store.append("doc-1", [makeStep(0), makeStep(1)]);
    const steps = await store.getDocument("doc-1");
    expect(steps).toHaveLength(2);
  });
});

describe("prune", () => {
  test("prunes documents older than threshold", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    // Step at timestamp 1700000000000
    await store.append("old-doc", [makeStep(0)]);
    // Step at timestamp 1700000010000
    await store.append("new-doc", [{ ...makeStep(0), timestamp: 1700000010000 }]);

    const pruned = await store.prune(1700000005000);
    expect(pruned).toBe(1);

    // Old doc should be gone
    expect(await store.getDocument("old-doc")).toEqual([]);
    // New doc should still exist
    expect(await store.getDocument("new-doc")).toHaveLength(1);
  });

  test("returns 0 when nothing to prune", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });
    await store.append("doc-1", [makeStep(0)]);
    const pruned = await store.prune(0);
    expect(pruned).toBe(0);
  });
});

describe("delegate error resilience", () => {
  test("prune continues to next doc on read failure", async () => {
    const realDelegate = createInMemoryAtifDelegate();

    // Set up two docs through the real delegate
    const tempStore = createAtifDocumentStore({ agentName: "test" }, realDelegate);
    await tempStore.append("doc-ok", [{ ...makeStep(0), timestamp: 1000 }]);
    await tempStore.append("doc-fail", [{ ...makeStep(1), timestamp: 2000 }]);

    // Create a delegate that fails on one specific doc
    // let: mutable counter for tracking calls
    let readCallCount = 0;
    const failingDelegate: AtifDocumentDelegate = {
      ...realDelegate,
      async read(docId: string) {
        readCallCount += 1;
        if (docId === "doc-fail") throw new Error("read failure");
        return realDelegate.read(docId);
      },
    };

    const store = createAtifDocumentStore({ agentName: "test" }, failingDelegate);
    // Prune with a threshold that would delete both
    const pruned = await store.prune(Date.now());
    // Only doc-ok was prunable (doc-fail threw on read)
    expect(pruned).toBe(1);
    expect(readCallCount).toBeGreaterThan(0);
  });
});

describe("concurrent append serialization", () => {
  test("concurrent appends to same docId do not lose data", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });

    // Launch 5 concurrent appends to the same doc
    await Promise.all([
      store.append("doc-1", [makeStep(0)]),
      store.append("doc-1", [makeStep(1)]),
      store.append("doc-1", [makeStep(2)]),
      store.append("doc-1", [makeStep(3)]),
      store.append("doc-1", [makeStep(4)]),
    ]);

    const steps = await store.getDocument("doc-1");
    // All 5 steps should be present — none lost to race conditions
    expect(steps).toHaveLength(5);
  });

  test("concurrent appends to different docIds run independently", async () => {
    const store = createInMemoryAtifDocumentStore({ agentName: "test" });

    await Promise.all([store.append("doc-a", [makeStep(0)]), store.append("doc-b", [makeStep(0)])]);

    expect(await store.getDocument("doc-a")).toHaveLength(1);
    expect(await store.getDocument("doc-b")).toHaveLength(1);
  });
});

describe("oversized single step", () => {
  test("single step exceeding maxSizeBytes is truncated, not written as-is", async () => {
    const store = createInMemoryAtifDocumentStore({
      agentName: "test",
      maxSizeBytes: 500, // very small budget
    });

    // Step with a very large response
    const hugeStep: RichTrajectoryStep = {
      ...makeStep(0),
      response: { text: "x".repeat(10000) },
    };

    await store.append("doc-1", [hugeStep]);

    // Document should exist but be truncated
    const steps = await store.getDocument("doc-1");
    expect(steps).toHaveLength(1);

    // The stored size should be within the budget (approximately)
    const size = await store.getSize("doc-1");
    expect(size).toBeLessThan(2000); // generous margin for truncation overhead
  });
});
