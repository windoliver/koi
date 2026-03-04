/**
 * Unit tests for createHarnessHandoffBridge.
 *
 * Uses mock stores to test: happy path, error cases, idempotency, hasFired, onEvent.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentId,
  AgentRegistry,
  HandoffEnvelope,
  HandoffEvent,
  HarnessSnapshot,
  HarnessSnapshotStore,
  KoiError,
  RegistryEntry,
  Result,
  SnapshotNode,
} from "@koi/core";
import { agentId, harnessId, taskItemId } from "@koi/core";
import type { HandoffStore } from "@koi/handoff";
import type { LongRunningHarness } from "@koi/long-running";
import { createHarnessHandoffBridge } from "./bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HARNESS_ID = harnessId("test-harness");
const TARGET_AGENT: AgentId = agentId("agent-b");

function createCompletedSnapshot(overrides?: Partial<HarnessSnapshot>): HarnessSnapshot {
  return {
    harnessId: HARNESS_ID,
    phase: "completed",
    sessionSeq: 2,
    taskBoard: {
      items: [],
      results: [
        {
          taskId: taskItemId("task-1"),
          output: "Done",
          durationMs: 5000,
        },
      ],
    },
    summaries: [
      {
        narrative: "Completed analysis phase",
        sessionSeq: 1,
        completedTaskIds: ["task-1"],
        estimatedTokens: 500,
        generatedAt: 1700000001000,
      },
    ],
    keyArtifacts: [
      {
        toolName: "file_write",
        content: "result data",
        turnIndex: 3,
        capturedAt: 1700000000000,
      },
    ],
    agentId: "agent-a",
    metrics: {
      totalSessions: 2,
      totalTurns: 10,
      totalInputTokens: 5000,
      totalOutputTokens: 2500,
      completedTaskCount: 1,
      pendingTaskCount: 0,
      elapsedMs: 60000,
    },
    startedAt: 1700000000000,
    checkpointedAt: 1700000060000,
    ...overrides,
  };
}

function createMockHarness(): LongRunningHarness {
  return {
    harnessId: HARNESS_ID,
    start: async () => ({ ok: true, value: { engineInput: {} as never, sessionId: "s-1" } }),
    resume: async () => ({
      ok: true,
      value: { engineInput: {} as never, sessionId: "s-1", engineStateRecovered: false },
    }),
    pause: async () => ({ ok: true, value: undefined }),
    fail: async () => ({ ok: true, value: undefined }),
    completeTask: async () => ({ ok: true, value: undefined }),
    status: () => ({
      harnessId: HARNESS_ID,
      phase: "completed",
      currentSessionSeq: 2,
      taskBoard: { items: [], results: [] },
      metrics: {
        totalSessions: 2,
        totalTurns: 10,
        totalInputTokens: 5000,
        totalOutputTokens: 2500,
        completedTaskCount: 1,
        pendingTaskCount: 0,
        elapsedMs: 60000,
      },
    }),
    createMiddleware: () => ({ name: "mock-mw", describeCapabilities: () => undefined }),
    dispose: async () => {},
  };
}

function createMockHarnessStore(snapshot?: HarnessSnapshot): HarnessSnapshotStore {
  const node: SnapshotNode<HarnessSnapshot> | undefined =
    snapshot !== undefined
      ? {
          nodeId: "node-1" as never,
          chainId: "test-harness" as never,
          parentIds: [],
          contentHash: "hash-1",
          data: snapshot,
          createdAt: Date.now(),
          metadata: {},
        }
      : undefined;

  return {
    head: mock(() =>
      Promise.resolve({ ok: true, value: node } as Result<
        SnapshotNode<HarnessSnapshot> | undefined,
        KoiError
      >),
    ),
    put: mock(() => Promise.resolve({ ok: true, value: undefined } as never)),
    get: mock(() => Promise.resolve({ ok: true, value: node } as never)),
    list: mock(() =>
      Promise.resolve({ ok: true, value: node !== undefined ? [node] : [] } as never),
    ),
    ancestors: mock(() => Promise.resolve({ ok: true, value: [] } as never)),
    fork: mock(() => Promise.resolve({ ok: true, value: {} } as never)),
    prune: mock(() => Promise.resolve({ ok: true, value: 0 } as never)),
    close: mock(() => {}),
  };
}

function createMockHandoffStore(): HandoffStore & {
  readonly storedEnvelopes: HandoffEnvelope[];
} {
  const storedEnvelopes: HandoffEnvelope[] = [];
  return {
    storedEnvelopes,
    put: mock((envelope: HandoffEnvelope) => {
      storedEnvelopes.push(envelope);
      return { ok: true, value: undefined } as Result<void, KoiError>;
    }),
    get: mock(
      () =>
        ({ ok: false, error: { code: "NOT_FOUND", message: "n/a", retryable: false } }) as never,
    ),
    transition: mock(() => ({ ok: true, value: {} }) as never),
    listByAgent: mock(() => ({ ok: true, value: [] }) as never),
    findPendingForAgent: mock(() => ({ ok: true, value: undefined }) as never),
    remove: mock(() => ({ ok: true, value: true }) as never),
    removeByAgent: mock(() => ({ ok: true, value: undefined }) as never),
    bindRegistry: mock(() => {}),
    dispose: mock(() => {}),
  };
}

function createMockRegistry(entries: readonly RegistryEntry[] = []): AgentRegistry {
  return {
    register: mock(() => entries[0] as RegistryEntry),
    deregister: mock(() => true),
    lookup: mock(() => undefined),
    list: mock(() => entries),
    transition: mock(() => ({ ok: true, value: entries[0] }) as never),
    patch: mock(() => ({ ok: true, value: entries[0] }) as never),
    watch: mock(() => () => {}),
    [Symbol.asyncDispose]: async () => {},
  };
}

function createRegistryEntry(id: AgentId): RegistryEntry {
  return {
    agentId: id,
    manifest: {
      name: "test-agent",
      model: "test",
    },
    phase: "running",
    generation: 1,
    capabilities: ["deploy"],
    tags: {},
    registeredAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as RegistryEntry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createHarnessHandoffBridge", () => {
  test("happy path: reads snapshot, maps to envelope, stores it", async () => {
    const snapshot = createCompletedSnapshot();
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(snapshot);
    const handoffStore = createMockHandoffStore();

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      targetAgentId: TARGET_AGENT,
    });

    expect(bridge.hasFired()).toBe(false);

    const result = await bridge.onHarnessCompleted();

    expect(result.ok).toBe(true);
    expect(bridge.hasFired()).toBe(true);

    // Verify envelope was stored
    expect(handoffStore.storedEnvelopes).toHaveLength(1);
    const stored = handoffStore.storedEnvelopes[0];
    expect(stored).toBeDefined();
    expect(stored?.from).toBe(agentId("agent-a"));
    expect(stored?.to).toBe(TARGET_AGENT);
    expect(stored?.status).toBe("pending");
    expect(stored?.context.artifacts).toHaveLength(1);
    expect(stored?.context.decisions).toHaveLength(1);
  });

  test("idempotent: second call returns same result", async () => {
    const snapshot = createCompletedSnapshot();
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(snapshot);
    const handoffStore = createMockHandoffStore();

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      targetAgentId: TARGET_AGENT,
    });

    const result1 = await bridge.onHarnessCompleted();
    const result2 = await bridge.onHarnessCompleted();

    expect(result1).toBe(result2); // Same reference — cached
    expect(handoffStore.storedEnvelopes).toHaveLength(1); // Only stored once
    expect(harnessStore.head).toHaveBeenCalledTimes(1); // Only read once
  });

  test("fires onEvent callback with prepared envelope", async () => {
    const snapshot = createCompletedSnapshot();
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(snapshot);
    const handoffStore = createMockHandoffStore();
    const onEvent = mock((_event: HandoffEvent) => {});

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      targetAgentId: TARGET_AGENT,
      onEvent,
    });

    await bridge.onHarnessCompleted();

    expect(onEvent).toHaveBeenCalledTimes(1);
    const event = onEvent.mock.calls[0]?.[0];
    expect(event).toBeDefined();
    expect(event?.kind).toBe("handoff:prepared");
    if (event !== undefined && event.kind === "handoff:prepared") {
      expect(event.envelope.to).toBe(TARGET_AGENT);
    }
  });

  test("uses custom nextPhaseInstructions", async () => {
    const snapshot = createCompletedSnapshot();
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(snapshot);
    const handoffStore = createMockHandoffStore();

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      targetAgentId: TARGET_AGENT,
      nextPhaseInstructions: "Deploy everything",
    });

    await bridge.onHarnessCompleted();

    const stored = handoffStore.storedEnvelopes[0];
    expect(stored?.phase.next).toBe("Deploy everything");
  });

  test("returns error when snapshot store head fails", async () => {
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore();
    // Override head to return error
    (harnessStore.head as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve({
        ok: false,
        error: { code: "INTERNAL", message: "DB down", retryable: false },
      }),
    );
    const handoffStore = createMockHandoffStore();

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      targetAgentId: TARGET_AGENT,
    });

    const result = await bridge.onHarnessCompleted();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("Failed to read harness snapshot");
    }
    expect(bridge.hasFired()).toBe(false);
  });

  test("returns error when no snapshot exists", async () => {
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(undefined);
    const handoffStore = createMockHandoffStore();

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      targetAgentId: TARGET_AGENT,
    });

    const result = await bridge.onHarnessCompleted();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("No harness snapshot found");
    }
    expect(bridge.hasFired()).toBe(false);
  });

  test("returns error when harness phase is not completed", async () => {
    const snapshot = createCompletedSnapshot({ phase: "active" });
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(snapshot);
    const handoffStore = createMockHandoffStore();

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      targetAgentId: TARGET_AGENT,
    });

    const result = await bridge.onHarnessCompleted();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain('"active"');
      expect(result.error.message).toContain('"completed"');
    }
    expect(bridge.hasFired()).toBe(false);
  });

  test("returns error when handoff store put fails", async () => {
    const snapshot = createCompletedSnapshot();
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(snapshot);
    const handoffStore = createMockHandoffStore();
    // Override put to return error
    (handoffStore.put as ReturnType<typeof mock>).mockImplementation(() => ({
      ok: false,
      error: { code: "CONFLICT", message: "Duplicate", retryable: false },
    }));

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      targetAgentId: TARGET_AGENT,
    });

    const result = await bridge.onHarnessCompleted();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("Failed to store handoff envelope");
    }
    expect(bridge.hasFired()).toBe(false);
  });

  test("resolves target dynamically via resolveTarget callback", async () => {
    const snapshot = createCompletedSnapshot();
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(snapshot);
    const handoffStore = createMockHandoffStore();
    const dynamicTarget = agentId("dynamic-agent");

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      resolveTarget: async (_snap) => dynamicTarget,
    });

    const result = await bridge.onHarnessCompleted();

    expect(result.ok).toBe(true);
    expect(handoffStore.storedEnvelopes).toHaveLength(1);
    expect(handoffStore.storedEnvelopes[0]?.to).toBe(dynamicTarget);
  });

  test("returns error when resolveTarget throws", async () => {
    const snapshot = createCompletedSnapshot();
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(snapshot);
    const handoffStore = createMockHandoffStore();

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      resolveTarget: async () => {
        throw new Error("No agent with capability");
      },
    });

    const result = await bridge.onHarnessCompleted();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toBe("No agent with capability");
    }
    expect(bridge.hasFired()).toBe(false);
  });

  test("throws when both targetAgentId and resolveTarget are provided", () => {
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore();
    const handoffStore = createMockHandoffStore();

    expect(() =>
      createHarnessHandoffBridge(harness, {
        harnessStore,
        handoffStore,
        targetAgentId: TARGET_AGENT,
        resolveTarget: async () => TARGET_AGENT,
      }),
    ).toThrow(
      "provide exactly one of targetAgentId, resolveTarget, or registry + targetCapability",
    );
  });

  test("throws when no target strategy is provided", () => {
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore();
    const handoffStore = createMockHandoffStore();

    expect(() =>
      createHarnessHandoffBridge(harness, {
        harnessStore,
        handoffStore,
      }),
    ).toThrow("one of targetAgentId, resolveTarget, or registry + targetCapability is required");
  });

  test("resolves target via targetCapability + registry", async () => {
    const snapshot = createCompletedSnapshot();
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(snapshot);
    const handoffStore = createMockHandoffStore();
    const capabilityTarget = agentId("deploy-agent");
    const registry = createMockRegistry([createRegistryEntry(capabilityTarget)]);

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      registry,
      targetCapability: "deploy",
    });

    const result = await bridge.onHarnessCompleted();

    expect(result.ok).toBe(true);
    expect(handoffStore.storedEnvelopes).toHaveLength(1);
    expect(handoffStore.storedEnvelopes[0]?.to).toBe(capabilityTarget);
  });

  test("throws when targetCapability provided without registry", () => {
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore();
    const handoffStore = createMockHandoffStore();

    expect(() =>
      createHarnessHandoffBridge(harness, {
        harnessStore,
        handoffStore,
        targetCapability: "deploy",
      }),
    ).toThrow("targetCapability requires registry");
  });

  test("throws when registry provided without targetCapability", () => {
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore();
    const handoffStore = createMockHandoffStore();
    const registry = createMockRegistry();

    expect(() =>
      createHarnessHandoffBridge(harness, {
        harnessStore,
        handoffStore,
        registry,
      }),
    ).toThrow("registry requires targetCapability");
  });

  test("throws when targetCapability combined with targetAgentId", () => {
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore();
    const handoffStore = createMockHandoffStore();
    const registry = createMockRegistry();

    expect(() =>
      createHarnessHandoffBridge(harness, {
        harnessStore,
        handoffStore,
        targetAgentId: TARGET_AGENT,
        registry,
        targetCapability: "deploy",
      }),
    ).toThrow(
      "provide exactly one of targetAgentId, resolveTarget, or registry + targetCapability",
    );
  });

  test("does not fire onEvent on error", async () => {
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(undefined);
    const handoffStore = createMockHandoffStore();
    const onEvent = mock((_event: HandoffEvent) => {});

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      targetAgentId: TARGET_AGENT,
      onEvent,
    });

    await bridge.onHarnessCompleted();

    expect(onEvent).not.toHaveBeenCalled();
  });

  test("propagates retryable from harnessStore.head error", async () => {
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore();
    (harnessStore.head as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve({
        ok: false,
        error: { code: "INTERNAL", message: "DB down", retryable: true },
      }),
    );
    const handoffStore = createMockHandoffStore();

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      targetAgentId: TARGET_AGENT,
    });

    const result = await bridge.onHarnessCompleted();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }
  });

  test("propagates retryable from handoffStore.put error", async () => {
    const snapshot = createCompletedSnapshot();
    const harness = createMockHarness();
    const harnessStore = createMockHarnessStore(snapshot);
    const handoffStore = createMockHandoffStore();
    (handoffStore.put as ReturnType<typeof mock>).mockImplementation(() => ({
      ok: false,
      error: { code: "CONFLICT", message: "Duplicate", retryable: true },
    }));

    const bridge = createHarnessHandoffBridge(harness, {
      harnessStore,
      handoffStore,
      targetAgentId: TARGET_AGENT,
    });

    const result = await bridge.onHarnessCompleted();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }
  });
});
