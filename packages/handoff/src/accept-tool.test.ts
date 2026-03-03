import { beforeEach, describe, expect, test } from "bun:test";
import type { HandoffEnvelope, HandoffEvent, JsonObject } from "@koi/core";
import { agentId, handoffId } from "@koi/core";
import { createAcceptTool } from "./accept-tool.js";
import { createInMemoryHandoffStore, type HandoffStore } from "./store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestEnvelope(overrides?: Partial<HandoffEnvelope>): HandoffEnvelope {
  return {
    id: handoffId("hoff-1"),
    from: agentId("agent-a"),
    to: agentId("agent-b"),
    status: "pending",
    createdAt: Date.now(),
    phase: { completed: "phase 1 done", next: "do phase 2" },
    context: {
      results: { answer: 42 },
      artifacts: [],
      decisions: [],
      warnings: [],
    },
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("accept_handoff tool", () => {
  let store: HandoffStore;
  const events: HandoffEvent[] = [];

  beforeEach(() => {
    store = createInMemoryHandoffStore();
    events.length = 0;
  });

  function makeTool(targetAgentId = "agent-b"): ReturnType<typeof createAcceptTool> {
    return createAcceptTool({
      store,
      agentId: agentId(targetAgentId),
      onEvent: (e) => {
        events.push(e);
      },
    });
  }

  test("accepts pending envelope and returns full context", async () => {
    const envelope = createTestEnvelope();
    store.put(envelope);

    const tool = makeTool();
    const result = (await tool.execute({ handoff_id: "hoff-1" } as JsonObject)) as Record<
      string,
      unknown
    >;

    expect(result.handoffId).toBe("hoff-1");
    expect(result.from).toBe("agent-a");
    expect(result.results).toEqual({ answer: 42 });
    expect(result.phase).toEqual({ completed: "phase 1 done", next: "do phase 2" });

    // Verify status transitioned
    const stored = await store.get(handoffId("hoff-1"));
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.value.status).toBe("accepted");
    }
  });

  test("emits handoff:accepted event", async () => {
    store.put(createTestEnvelope());

    const tool = makeTool();
    await tool.execute({ handoff_id: "hoff-1" } as JsonObject);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("handoff:accepted");
  });

  test("returns NOT_FOUND for missing envelope", async () => {
    const tool = makeTool();
    const result = (await tool.execute({ handoff_id: "nonexistent" } as JsonObject)) as {
      output: null;
      metadata: { error: { code: string } };
    };

    expect(result.output).toBeNull();
    expect(result.metadata.error.code).toBe("NOT_FOUND");
  });

  test("returns ALREADY_ACCEPTED for accepted envelope", async () => {
    store.put(createTestEnvelope({ status: "accepted" }));

    const tool = makeTool();
    const result = (await tool.execute({ handoff_id: "hoff-1" } as JsonObject)) as {
      output: null;
      metadata: { error: { code: string } };
    };

    expect(result.output).toBeNull();
    expect(result.metadata.error.code).toBe("ALREADY_ACCEPTED");
  });

  test("returns TARGET_MISMATCH for wrong agent", async () => {
    store.put(createTestEnvelope({ to: agentId("agent-c") }));

    const tool = makeTool("agent-b");
    const result = (await tool.execute({ handoff_id: "hoff-1" } as JsonObject)) as {
      output: null;
      metadata: { error: { code: string } };
    };

    expect(result.output).toBeNull();
    expect(result.metadata.error.code).toBe("TARGET_MISMATCH");
  });

  test("returns EXPIRED for expired envelope", async () => {
    store.put(createTestEnvelope({ status: "expired" }));

    const tool = makeTool();
    const result = (await tool.execute({ handoff_id: "hoff-1" } as JsonObject)) as {
      output: null;
      metadata: { error: { code: string } };
    };

    expect(result.output).toBeNull();
    expect(result.metadata.error.code).toBe("EXPIRED");
  });

  test("returns validation error for missing handoff_id", async () => {
    const tool = makeTool();
    const result = (await tool.execute({} as JsonObject)) as {
      output: null;
      metadata: { error: { code: string } };
    };

    expect(result.output).toBeNull();
    expect(result.metadata.error.code).toBe("VALIDATION");
  });

  test("includes artifact warnings in result", async () => {
    const envelope = createTestEnvelope({
      context: {
        results: {},
        artifacts: [{ id: "a1", kind: "data", uri: "s3://bucket/key" }],
        decisions: [],
        warnings: [],
      },
    });
    store.put(envelope);

    const tool = makeTool();
    const result = (await tool.execute({ handoff_id: "hoff-1" } as JsonObject)) as Record<
      string,
      unknown
    >;

    const warnings = result.warnings as readonly string[];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("unsupported URI scheme");
  });

  test("accepts injected envelope (pending -> injected -> accepted)", async () => {
    store.put(createTestEnvelope({ status: "injected" }));

    const tool = makeTool();
    const result = (await tool.execute({ handoff_id: "hoff-1" } as JsonObject)) as Record<
      string,
      unknown
    >;

    expect(result.handoffId).toBe("hoff-1");
    const stored = await store.get(handoffId("hoff-1"));
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.value.status).toBe("accepted");
    }
  });

  test("returns delegation grant if present", async () => {
    const mockGrant = {
      id: "del-1",
      issuerId: "agent-a",
      delegateeId: "agent-b",
      scope: { permissions: {} },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      signature: "test-sig",
    };
    store.put(
      createTestEnvelope({ delegation: mockGrant as unknown as HandoffEnvelope["delegation"] }),
    );

    const tool = makeTool();
    const result = (await tool.execute({ handoff_id: "hoff-1" } as JsonObject)) as Record<
      string,
      unknown
    >;

    expect(result.delegation).toBeDefined();
  });
});
