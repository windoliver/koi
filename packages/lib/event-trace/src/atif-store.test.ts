import { describe, expect, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core";
import { createInMemoryTrajectoryStore } from "./atif-store.js";

function makeStep(index: number, timestamp = Date.now()): RichTrajectoryStep {
  return {
    stepIndex: index,
    timestamp,
    source: "agent",
    kind: "model_call",
    identifier: "test-model",
    outcome: "success",
    durationMs: 100,
  };
}

describe("createInMemoryTrajectoryStore", () => {
  test("append + getDocument", async () => {
    const store = createInMemoryTrajectoryStore();
    await store.append("doc-1", [makeStep(0), makeStep(1)]);
    const steps = await store.getDocument("doc-1");
    expect(steps).toHaveLength(2);
    expect(steps[0]?.stepIndex).toBe(0);
  });

  test("append accumulates steps", async () => {
    const store = createInMemoryTrajectoryStore();
    await store.append("doc-1", [makeStep(0)]);
    await store.append("doc-1", [makeStep(1)]);
    const steps = await store.getDocument("doc-1");
    expect(steps).toHaveLength(2);
  });

  test("getDocument returns empty for unknown doc", async () => {
    const store = createInMemoryTrajectoryStore();
    const steps = await store.getDocument("unknown");
    expect(steps).toHaveLength(0);
  });

  test("getStepRange returns filtered steps", async () => {
    const store = createInMemoryTrajectoryStore();
    await store.append("doc-1", [makeStep(0), makeStep(1), makeStep(2), makeStep(3)]);
    const range = await store.getStepRange("doc-1", 1, 3);
    expect(range).toHaveLength(2);
    expect(range[0]?.stepIndex).toBe(1);
    expect(range[1]?.stepIndex).toBe(2);
  });

  test("getSize returns byte length", async () => {
    const store = createInMemoryTrajectoryStore();
    await store.append("doc-1", [makeStep(0)]);
    const size = await store.getSize("doc-1");
    expect(size).toBeGreaterThan(0);
  });

  test("getSize returns 0 for empty doc", async () => {
    const store = createInMemoryTrajectoryStore();
    expect(await store.getSize("unknown")).toBe(0);
  });

  test("prune removes old documents", async () => {
    const store = createInMemoryTrajectoryStore();
    const oldTime = 1000;
    const newTime = Date.now();
    await store.append("old-doc", [makeStep(0, oldTime)]);
    await store.append("new-doc", [makeStep(0, newTime)]);

    const pruned = await store.prune(2000);
    expect(pruned).toBe(1);
    expect(await store.getDocument("old-doc")).toHaveLength(0);
    expect(await store.getDocument("new-doc")).toHaveLength(1);
  });
});
