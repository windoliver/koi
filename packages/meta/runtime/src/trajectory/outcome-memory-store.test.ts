import { describe, expect, test } from "bun:test";
import type { OutcomeReport } from "@koi/core";
import { decisionCorrelationId } from "@koi/core";
import { createInMemoryOutcomeStore } from "./outcome-memory-store.js";

function makeReport(id: string, outcome: "positive" | "negative" = "positive"): OutcomeReport {
  return {
    correlationId: decisionCorrelationId(id),
    outcome,
    metrics: { score: 42 },
    description: `Test outcome for ${id}`,
    reportedBy: "test",
    timestamp: Date.now(),
  };
}

describe("createInMemoryOutcomeStore", () => {
  test("put then get returns the report", async () => {
    const store = createInMemoryOutcomeStore();
    const report = makeReport("dcid_1");

    await store.put(report);
    const result = await store.get("dcid_1");

    expect(result).toEqual(report);
  });

  test("get returns undefined for unknown ID", async () => {
    const store = createInMemoryOutcomeStore();

    const result = await store.get("dcid_unknown");

    expect(result).toBeUndefined();
  });

  test("put overwrites existing report for same ID", async () => {
    const store = createInMemoryOutcomeStore();

    await store.put(makeReport("dcid_dup", "positive"));
    await store.put(makeReport("dcid_dup", "negative"));

    const result = await store.get("dcid_dup");
    expect(result?.outcome).toBe("negative");
  });

  test("stores multiple reports independently", async () => {
    const store = createInMemoryOutcomeStore();

    await store.put(makeReport("dcid_a", "positive"));
    await store.put(makeReport("dcid_b", "negative"));

    expect((await store.get("dcid_a"))?.outcome).toBe("positive");
    expect((await store.get("dcid_b"))?.outcome).toBe("negative");
  });
});
