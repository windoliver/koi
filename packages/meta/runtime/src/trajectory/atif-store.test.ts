import { describe, expect, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core";
import type { AtifDocumentDelegate } from "./atif-store.js";
import { createAtifDocumentStore } from "./atif-store.js";
import type { AtifDocument } from "./atif-types.js";

function createInMemoryDelegate(): AtifDocumentDelegate {
  const docs = new Map<string, AtifDocument>();
  return {
    async read(docId: string) {
      return docs.get(docId);
    },
    async write(docId: string, doc: AtifDocument) {
      docs.set(docId, doc);
    },
    async list() {
      return [...docs.keys()];
    },
    async delete(docId: string) {
      return docs.delete(docId);
    },
  };
}

function makeStep(
  index: number,
  kind: "model_call" | "tool_call" = "model_call",
): RichTrajectoryStep {
  return {
    stepIndex: index,
    timestamp: Date.now(),
    source: "agent",
    kind,
    identifier: kind === "model_call" ? "gpt-4" : "read_file",
    outcome: "success",
    durationMs: 100,
    request: { text: "test request" },
    response: { text: "test response" },
  };
}

describe("createAtifDocumentStore", () => {
  test("append and retrieve steps", async () => {
    const store = createAtifDocumentStore({ agentName: "test" }, createInMemoryDelegate());

    await store.append("session-1", [makeStep(0), makeStep(1)]);
    const steps = await store.getDocument("session-1");

    expect(steps).toHaveLength(2);
    expect(steps[0]?.stepIndex).toBe(0);
    expect(steps[1]?.stepIndex).toBe(1);
  });

  test("append accumulates across calls", async () => {
    const store = createAtifDocumentStore({ agentName: "test" }, createInMemoryDelegate());

    await store.append("session-1", [makeStep(0)]);
    await store.append("session-1", [makeStep(1)]);
    const steps = await store.getDocument("session-1");

    expect(steps).toHaveLength(2);
  });

  test("getDocument returns empty for missing doc", async () => {
    const store = createAtifDocumentStore({ agentName: "test" }, createInMemoryDelegate());

    const steps = await store.getDocument("nonexistent");
    expect(steps).toEqual([]);
  });

  test("getStepRange returns filtered range", async () => {
    const store = createAtifDocumentStore({ agentName: "test" }, createInMemoryDelegate());

    await store.append("session-1", [makeStep(0), makeStep(1), makeStep(2), makeStep(3)]);
    const range = await store.getStepRange("session-1", 1, 3);

    expect(range).toHaveLength(2);
    expect(range[0]?.stepIndex).toBe(1);
    expect(range[1]?.stepIndex).toBe(2);
  });

  test("getSize returns approximate byte size", async () => {
    const store = createAtifDocumentStore({ agentName: "test" }, createInMemoryDelegate());

    await store.append("session-1", [makeStep(0)]);
    const size = await store.getSize("session-1");
    expect(size).toBeGreaterThan(0);
  });

  test("getSize returns 0 for missing doc", async () => {
    const store = createAtifDocumentStore({ agentName: "test" }, createInMemoryDelegate());

    expect(await store.getSize("nope")).toBe(0);
  });

  test("enriches agent.model_name from model_call steps", async () => {
    const delegate = createInMemoryDelegate();
    const store = createAtifDocumentStore({ agentName: "test" }, delegate);

    await store.append("enrich-test", [
      makeStep(0, "model_call"), // identifier is "gpt-4"
    ]);

    // Read raw ATIF document to check agent metadata
    const doc = await delegate.read("enrich-test");
    expect(doc?.agent.model_name).toBe("gpt-4");
  });

  test("enriches agent.tool_definitions from tool_call steps", async () => {
    const delegate = createInMemoryDelegate();
    const store = createAtifDocumentStore({ agentName: "test" }, delegate);

    await store.append("tool-enrich", [
      makeStep(0, "tool_call"), // identifier is "read_file"
    ]);

    const doc = await delegate.read("tool-enrich");
    expect(doc?.agent.tool_definitions).toBeDefined();
    expect(doc?.agent.tool_definitions?.length).toBe(1);
    expect(doc?.agent.tool_definitions?.[0]?.name).toBe("read_file");
  });

  test("enriches tool_definitions from step metadata.tools", async () => {
    const delegate = createInMemoryDelegate();
    const store = createAtifDocumentStore({ agentName: "test" }, delegate);

    const step: RichTrajectoryStep = {
      stepIndex: 0,
      timestamp: Date.now(),
      source: "agent",
      kind: "model_call",
      identifier: "gpt-4",
      outcome: "success",
      durationMs: 100,
      metadata: {
        tools: [
          { name: "add_numbers", description: "Add two numbers" },
          { name: "read_file", description: "Read a file" },
        ],
      },
    };

    await store.append("tools-meta", [step]);

    const doc = await delegate.read("tools-meta");
    expect(doc?.agent.model_name).toBe("gpt-4");
    expect(doc?.agent.tool_definitions?.length).toBe(2);
    expect(doc?.agent.tool_definitions?.[0]?.name).toBe("add_numbers");
    expect(doc?.agent.tool_definitions?.[0]?.description).toBe("Add two numbers");
    expect(doc?.agent.tool_definitions?.[1]?.name).toBe("read_file");
  });
});
