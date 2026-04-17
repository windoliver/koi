import { describe, expect, test } from "bun:test";
import type {
  EngineEvent,
  EngineInput,
  EngineOutput,
  InboxComponent,
  InboxItem,
  ProcessId,
  ReportStore,
  RunReport,
} from "@koi/core";
import { agentId, isDeliveryPolicy } from "@koi/core";
import type { DeliveryHandle } from "./delivery-policy.js";
import { applyDeliveryPolicy, resolveDeliveryPolicy } from "./delivery-policy.js";
import type { SpawnChildResult } from "./types.js";

/**
 * Extract runChild from a DeliveryHandle, failing fast if undefined.
 * Avoids non-null assertions (`!`) banned by biome.
 */
function requireRunChild(handle: DeliveryHandle): (input: EngineInput) => Promise<void> {
  const { runChild } = handle;
  if (runChild === undefined) throw new Error("Expected runChild to be defined");
  return runChild;
}

/**
 * Create an async iterable that throws on first iteration.
 * Uses Symbol.asyncIterator instead of `async function*` to avoid biome useYield lint.
 */
function createFailingStream(error: Error): AsyncIterable<EngineEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(error),
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockChildPid(): ProcessId {
  return {
    id: agentId("child-1"),
    name: "child-1",
    type: "worker",
    parentId: agentId("parent-1"),
    depth: 1,
    createdAt: Date.now(),
  } as unknown as ProcessId;
}

function createMockEngineOutput(text: string): EngineOutput {
  return {
    content: [{ kind: "text", text }],
    stopReason: "completed",
    metrics: {
      totalTokens: 100,
      inputTokens: 50,
      outputTokens: 50,
      turns: 1,
      durationMs: 500,
    },
  };
}

function createDoneEvent(text: string): EngineEvent {
  return { kind: "done", output: createMockEngineOutput(text) };
}

async function* streamEvents(...events: readonly EngineEvent[]): AsyncIterable<EngineEvent> {
  for (const event of events) {
    yield event;
  }
}

function createMockSpawnResult(events: readonly EngineEvent[]): SpawnChildResult {
  const childPid = createMockChildPid();
  return {
    runtime: {
      agent: {
        pid: childPid,
        manifest: { name: "child", version: "1.0.0", model: { name: "test" } },
      } as SpawnChildResult["runtime"]["agent"],
      sessionId: "test-session",
      currentRunId: undefined,
      conflicts: [],
      run: (_input: EngineInput) => streamEvents(...events),
      interrupt: () => false,
      isInterrupted: () => false,
      dispose: async () => {},
    },
    handle: {
      childId: childPid.id,
      name: "child",
      onEvent: () => () => {},
      signal: () => {},
      terminate: () => {},
      waitForCompletion: async () => ({ childId: childPid.id, exitCode: 0 }),
    },
    childPid,
  };
}

function createMockInbox(): InboxComponent & { readonly items: InboxItem[] } {
  const items: InboxItem[] = [];
  return {
    items,
    drain: () => {
      const drained = [...items];
      items.length = 0;
      return drained;
    },
    peek: () => [...items],
    depth: () => items.length,
    push: (item: InboxItem) => {
      items.push(item);
      return true;
    },
  };
}

function createFullInbox(): InboxComponent {
  return {
    drain: () => [],
    peek: () => [],
    depth: () => 100,
    push: (_item: InboxItem) => false,
  };
}

function createMockReportStore(): ReportStore & { readonly reports: RunReport[] } {
  const reports: RunReport[] = [];
  return {
    reports,
    put: async (report: RunReport) => {
      reports.push(report);
    },
    getBySession: async () => reports,
  };
}

const dummyInput: EngineInput = { kind: "text", text: "do the thing" };

// ---------------------------------------------------------------------------
// resolveDeliveryPolicy
// ---------------------------------------------------------------------------

describe("resolveDeliveryPolicy", () => {
  test("spawn delivery wins over manifest", () => {
    const result = resolveDeliveryPolicy({ kind: "deferred" }, { kind: "on_demand" });
    expect(result.kind).toBe("deferred");
  });

  test("manifest used when spawn is undefined", () => {
    const result = resolveDeliveryPolicy(undefined, { kind: "on_demand" });
    expect(result.kind).toBe("on_demand");
  });

  test("defaults to streaming when both undefined", () => {
    const result = resolveDeliveryPolicy(undefined, undefined);
    expect(result.kind).toBe("streaming");
  });

  test("streaming spawn overrides deferred manifest", () => {
    const result = resolveDeliveryPolicy({ kind: "streaming" }, { kind: "deferred" });
    expect(result.kind).toBe("streaming");
  });
});

// ---------------------------------------------------------------------------
// applyDeliveryPolicy — streaming
// ---------------------------------------------------------------------------

describe("applyDeliveryPolicy — streaming", () => {
  test("returns spawnResult unchanged", () => {
    const spawnResult = createMockSpawnResult([createDoneEvent("hello")]);
    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "streaming" },
    });
    expect(handle.spawnResult).toBe(spawnResult);
  });

  test("runChild is undefined (no wrapper)", () => {
    const spawnResult = createMockSpawnResult([createDoneEvent("hello")]);
    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "streaming" },
    });
    expect(handle.runChild).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyDeliveryPolicy — deferred
// ---------------------------------------------------------------------------

describe("applyDeliveryPolicy — deferred", () => {
  test("consumes all child events and extracts output text", async () => {
    const events: EngineEvent[] = [
      { kind: "turn_start", turnIndex: 0 },
      { kind: "text_delta", delta: "hi" },
      { kind: "turn_end", turnIndex: 0 },
      createDoneEvent("final output"),
    ];
    const spawnResult = createMockSpawnResult(events);
    const inbox = createMockInbox();

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "deferred" },
      parentInbox: inbox,
      parentAgentId: agentId("parent-1"),
    });

    expect(handle.runChild).toBeDefined();
    await requireRunChild(handle)(dummyInput);

    expect(inbox.items.length).toBe(1);
    const item = inbox.items[0];
    expect(item).toBeDefined();
    expect(item?.content).toBe("final output");
  });

  test("pushes to inbox with correct mode from policy", async () => {
    const spawnResult = createMockSpawnResult([createDoneEvent("result")]);
    const inbox = createMockInbox();

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "deferred", inboxMode: "followup" },
      parentInbox: inbox,
    });

    await requireRunChild(handle)(dummyInput);

    const item = inbox.items[0];
    expect(item?.mode).toBe("followup");
  });

  test("uses collect mode by default", async () => {
    const spawnResult = createMockSpawnResult([createDoneEvent("result")]);
    const inbox = createMockInbox();

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "deferred" },
      parentInbox: inbox,
    });

    await requireRunChild(handle)(dummyInput);

    const item = inbox.items[0];
    expect(item?.mode).toBe("collect");
  });

  test("throws KoiRuntimeError when inbox is full (hard delivery failure)", async () => {
    const spawnResult = createMockSpawnResult([createDoneEvent("result")]);
    const fullInbox = createFullInbox();

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "deferred" },
      parentInbox: fullInbox,
    });

    // Inbox full is now a hard failure — caller must not lose child output silently.
    // The background task (createAgentSpawnFn) catches this and pushes an error inbox item.
    await expect(requireRunChild(handle)(dummyInput)).rejects.toThrow(
      "Deferred delivery: parent inbox at capacity",
    );
  });

  test("handles stream error (rethrows with cause)", async () => {
    const streamError = new Error("stream exploded");
    const failingStream = createFailingStream(streamError);

    const childPid = createMockChildPid();
    const spawnResult: SpawnChildResult = {
      runtime: {
        agent: {
          pid: childPid,
          manifest: { name: "child", version: "1.0.0", model: { name: "test" } },
        } as SpawnChildResult["runtime"]["agent"],
        sessionId: "test-session",
        conflicts: [],
        currentRunId: undefined,
        run: () => failingStream,
        interrupt: () => false,
        isInterrupted: () => false,
        dispose: async () => {},
      },
      handle: {
        childId: childPid.id,
        name: "child",
        onEvent: () => () => {},
        signal: () => {},
        terminate: () => {},
        waitForCompletion: async () => ({ childId: childPid.id, exitCode: 0 }),
      },
      childPid,
    };

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "deferred" },
      parentInbox: createMockInbox(),
    });

    await expect(requireRunChild(handle)(dummyInput)).rejects.toThrow(
      "Deferred delivery: child stream error",
    );
  });

  test("handles missing done event (throws INTERNAL error)", async () => {
    const events: EngineEvent[] = [
      { kind: "turn_start", turnIndex: 0 },
      { kind: "turn_end", turnIndex: 0 },
      // No done event
    ];
    const spawnResult = createMockSpawnResult(events);

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "deferred" },
      parentInbox: createMockInbox(),
    });

    await expect(requireRunChild(handle)(dummyInput)).rejects.toThrow(
      "Child stream ended without a done event",
    );
  });

  test("skips inbox push when parentInbox is undefined", async () => {
    const spawnResult = createMockSpawnResult([createDoneEvent("result")]);

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "deferred" },
      // No parentInbox
    });

    // Should not throw
    await requireRunChild(handle)(dummyInput);
  });
});

// ---------------------------------------------------------------------------
// applyDeliveryPolicy — on_demand
// ---------------------------------------------------------------------------

describe("applyDeliveryPolicy — on_demand", () => {
  test("consumes all child events and writes RunReport", async () => {
    const spawnResult = createMockSpawnResult([createDoneEvent("analysis complete")]);
    const store = createMockReportStore();

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "on_demand" },
      reportStore: store,
    });

    expect(handle.runChild).toBeDefined();
    await requireRunChild(handle)(dummyInput);

    expect(store.reports.length).toBe(1);
    const report0 = store.reports[0];
    expect(report0).toBeDefined();
    expect(report0?.summary).toBe("analysis complete");
  });

  test("populates RunReport metrics from engine output", async () => {
    const spawnResult = createMockSpawnResult([createDoneEvent("done")]);
    const store = createMockReportStore();

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "on_demand" },
      reportStore: store,
    });

    await requireRunChild(handle)(dummyInput);

    const report = store.reports[0];
    expect(report).toBeDefined();
    expect(report?.cost.inputTokens).toBe(50);
    expect(report?.cost.outputTokens).toBe(50);
    expect(report?.cost.totalTokens).toBe(100);
    expect(report?.duration.durationMs).toBe(500);
    expect(report?.duration.totalTurns).toBe(1);
  });

  test("handles ReportStore.put() failure (rethrows with cause)", async () => {
    const spawnResult = createMockSpawnResult([createDoneEvent("result")]);
    const storeError = new Error("disk full");
    const store: ReportStore = {
      put: async () => {
        throw storeError;
      },
      getBySession: async () => [],
    };

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "on_demand" },
      reportStore: store,
    });

    await expect(requireRunChild(handle)(dummyInput)).rejects.toThrow(
      "On-demand delivery: ReportStore.put() failed",
    );
  });

  test("handles stream error (rethrows with cause)", async () => {
    const failingStream = createFailingStream(new Error("stream broke"));

    const childPid = createMockChildPid();
    const spawnResult: SpawnChildResult = {
      runtime: {
        agent: {
          pid: childPid,
          manifest: { name: "child", version: "1.0.0", model: { name: "test" } },
        } as SpawnChildResult["runtime"]["agent"],
        sessionId: "test-session",
        conflicts: [],
        currentRunId: undefined,
        run: () => failingStream,
        interrupt: () => false,
        isInterrupted: () => false,
        dispose: async () => {},
      },
      handle: {
        childId: childPid.id,
        name: "child",
        onEvent: () => () => {},
        signal: () => {},
        terminate: () => {},
        waitForCompletion: async () => ({ childId: childPid.id, exitCode: 0 }),
      },
      childPid,
    };

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "on_demand" },
      reportStore: createMockReportStore(),
    });

    await expect(requireRunChild(handle)(dummyInput)).rejects.toThrow(
      "On-demand delivery: child stream error",
    );
  });

  test("handles missing done event (throws INTERNAL error)", async () => {
    const events: EngineEvent[] = [{ kind: "turn_start", turnIndex: 0 }];
    const spawnResult = createMockSpawnResult(events);

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "on_demand" },
      reportStore: createMockReportStore(),
    });

    await expect(requireRunChild(handle)(dummyInput)).rejects.toThrow(
      "Child stream ended without a done event",
    );
  });

  test("skips store write when reportStore is undefined", async () => {
    const spawnResult = createMockSpawnResult([createDoneEvent("result")]);

    const handle = applyDeliveryPolicy({
      spawnResult,
      policy: { kind: "on_demand" },
      // No reportStore
    });

    // Should not throw
    await requireRunChild(handle)(dummyInput);
  });
});

// ---------------------------------------------------------------------------
// isDeliveryPolicy (L0 type guard)
// ---------------------------------------------------------------------------

describe("isDeliveryPolicy", () => {
  test("returns true for all 3 valid policies", () => {
    expect(isDeliveryPolicy({ kind: "streaming" })).toBe(true);
    expect(isDeliveryPolicy({ kind: "deferred" })).toBe(true);
    expect(isDeliveryPolicy({ kind: "on_demand" })).toBe(true);
  });

  test("returns false for invalid values", () => {
    expect(isDeliveryPolicy(null)).toBe(false);
    expect(isDeliveryPolicy("streaming")).toBe(false);
    expect(isDeliveryPolicy({ kind: "unknown" })).toBe(false);
    expect(isDeliveryPolicy({})).toBe(false);
    expect(isDeliveryPolicy(42)).toBe(false);
  });
});
