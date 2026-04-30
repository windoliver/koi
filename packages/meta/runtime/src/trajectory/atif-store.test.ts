import { describe, expect, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core";
import type {
  AtifDocumentAppendBatch,
  AtifDocumentAppendState,
  AtifDocumentDelegate,
} from "./atif-store.js";
import { createAtifDocumentStore } from "./atif-store.js";
import type { AtifDocument, AtifStep } from "./atif-types.js";

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

function createAppendOnlyInMemoryDelegate(): AtifDocumentDelegate & {
  readonly counts: {
    read: number;
    write: number;
    appendSteps: number;
  };
} {
  const states = new Map<string, AtifDocumentAppendState>();
  const chunks = new Map<
    string,
    { readonly startIndex: number; readonly steps: readonly AtifStep[] }[]
  >();
  const counts = { read: 0, write: 0, appendSteps: 0 };

  function assemble(docId: string): AtifDocument | undefined {
    const state = states.get(docId);
    if (state === undefined) return undefined;
    const steps = (chunks.get(docId) ?? [])
      .slice()
      .sort((a, b) => a.startIndex - b.startIndex)
      .flatMap((chunk) => chunk.steps);
    return { ...state.document, steps };
  }

  function stateFromDocument(doc: AtifDocument): AtifDocumentAppendState {
    const lastStep = doc.steps[doc.steps.length - 1];
    return {
      document: {
        schema_version: doc.schema_version,
        session_id: doc.session_id,
        agent: doc.agent,
        ...(doc.notes !== undefined ? { notes: doc.notes } : {}),
        ...(doc.final_metrics !== undefined ? { final_metrics: doc.final_metrics } : {}),
        ...(doc.extra !== undefined ? { extra: doc.extra } : {}),
      },
      stepCount: doc.steps.length,
      nextStepIndex: lastStep === undefined ? 0 : lastStep.step_id + 1,
      lastTimestampMs: lastStep === undefined ? 0 : new Date(lastStep.timestamp).getTime(),
      sizeBytes: JSON.stringify(doc).length,
    };
  }

  return {
    counts,
    async read(docId: string) {
      counts.read += 1;
      return assemble(docId);
    },
    async write(docId: string, doc: AtifDocument) {
      counts.write += 1;
      states.set(docId, stateFromDocument(doc));
      chunks.set(docId, [{ startIndex: doc.steps[0]?.step_id ?? 0, steps: doc.steps }]);
    },
    async list() {
      return [...states.keys()];
    },
    async delete(docId: string) {
      const existed = states.delete(docId);
      chunks.delete(docId);
      return existed;
    },
    async readAppendState(docId: string) {
      return states.get(docId);
    },
    async appendSteps(docId: string, batch: AtifDocumentAppendBatch) {
      counts.appendSteps += 1;
      const { startIndex: _startIndex, steps: _steps, ...state } = batch;
      states.set(docId, state);
      chunks.set(docId, [
        ...(chunks.get(docId) ?? []),
        { startIndex: batch.startIndex, steps: batch.steps },
      ]);
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

  test("append uses append-only delegate path without whole-document rewrite", async () => {
    const delegate = createAppendOnlyInMemoryDelegate();
    const store = createAtifDocumentStore({ agentName: "test" }, delegate);

    await store.append("session-1", [makeStep(0)]);
    await store.append("session-1", [makeStep(1)]);

    expect(delegate.counts.read).toBe(0);
    expect(delegate.counts.write).toBe(0);
    expect(delegate.counts.appendSteps).toBe(2);

    const steps = await store.getDocument("session-1");
    expect(steps).toHaveLength(2);
    expect(steps[0]?.stepIndex).toBe(0);
    expect(steps[1]?.stepIndex).toBe(1);
  });

  test("pruning a large append does not shift once per dropped step", async () => {
    const originalShift = Array.prototype.shift;
    let shiftCalls = 0;
    Array.prototype.shift = function patchedShift<T>(this: T[]): T | undefined {
      shiftCalls += 1;
      return originalShift.call(this);
    };

    try {
      const delegate = createInMemoryDelegate();
      const store = createAtifDocumentStore({ agentName: "test", maxSizeBytes: 600 }, delegate);

      await store.append(
        "prune-test",
        Array.from({ length: 30 }, (_, index) => ({
          ...makeStep(index),
          request: { text: `request-${index}`.repeat(20) },
          response: { text: `response-${index}`.repeat(20) },
        })),
      );

      const doc = await delegate.read("prune-test");
      expect(doc?.steps.length).toBeGreaterThanOrEqual(1);
      expect(doc?.steps.length).toBeLessThan(30);
      expect(shiftCalls).toBeLessThan(5);
    } finally {
      Array.prototype.shift = originalShift;
    }
  });
});
