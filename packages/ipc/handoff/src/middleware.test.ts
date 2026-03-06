import { beforeEach, describe, expect, test } from "bun:test";
import type { HandoffEnvelope, HandoffEvent, ModelRequest, ModelResponse } from "@koi/core";
import { agentId, handoffId } from "@koi/core";
import { createMockTurnContext } from "@koi/test-utils";
import { createHandoffMiddleware } from "./middleware.js";
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
    phase: { completed: "Analyzed data", next: "Generate report" },
    context: {
      results: { answer: 42 },
      artifacts: [{ id: "a1", kind: "file", uri: "file:///out.json" }],
      decisions: [],
      warnings: ["Watch out for X"],
    },
    metadata: {},
    ...overrides,
  };
}

function createMockModelRequest(): ModelRequest {
  return {
    messages: [
      {
        senderId: "user-1",
        timestamp: Date.now(),
        content: [{ kind: "text", text: "Hello" }],
      },
    ],
    model: "test-model",
  };
}

const MOCK_RESPONSE: ModelResponse = {
  content: "test response",
  model: "test-model",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HandoffMiddleware", () => {
  let store: HandoffStore;
  const events: HandoffEvent[] = [];

  beforeEach(() => {
    store = createInMemoryHandoffStore();
    events.length = 0;
  });

  function makeMiddleware(targetAgentId = "agent-b"): ReturnType<typeof createHandoffMiddleware> {
    return createHandoffMiddleware({
      store,
      agentId: agentId(targetAgentId),
      onEvent: (e) => {
        events.push(e);
      },
    });
  }

  describe("onBeforeTurn", () => {
    test("injects handoffId and handoffPhase into turn metadata", async () => {
      store.put(createTestEnvelope());
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();

      await mw.onBeforeTurn?.(ctx);

      const meta = ctx.metadata as Record<string, unknown>;
      expect(meta.handoffId).toBe("hoff-1");
      expect(meta.handoffPhase).toBe("Generate report");
    });

    test("does nothing when no pending envelope", async () => {
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();

      await mw.onBeforeTurn?.(ctx);

      const meta = ctx.metadata as Record<string, unknown>;
      expect(meta.handoffId).toBeUndefined();
    });
  });

  describe("wrapModelCall", () => {
    test("injects summary into first model call", async () => {
      store.put(createTestEnvelope());
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();
      const request = createMockModelRequest();

      // let justified: tracking passed request
      let passedRequest: ModelRequest | undefined;
      const next = async (req: ModelRequest): Promise<ModelResponse> => {
        passedRequest = req;
        return MOCK_RESPONSE;
      };

      await mw.wrapModelCall?.(ctx, request, next);

      // Should have prepended system message
      expect(passedRequest?.messages.length).toBe(2);
      const systemMsg = passedRequest?.messages[0];
      expect(systemMsg?.senderId).toBe("system");
      const text = systemMsg?.content[0];
      expect(text?.kind).toBe("text");
      expect((text as { text: string } | undefined)?.text).toContain("Handoff Context");
      expect((text as { text: string } | undefined)?.text).toContain("Generate report");
      expect((text as { text: string }).text).toContain("accept_handoff");
    });

    test("transitions envelope to injected status", async () => {
      store.put(createTestEnvelope());
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();

      await mw.wrapModelCall?.(ctx, createMockModelRequest(), async () => MOCK_RESPONSE);

      const result = await store.get(handoffId("hoff-1"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("injected");
      }
    });

    test("emits handoff:injected event", async () => {
      store.put(createTestEnvelope());
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();

      await mw.wrapModelCall?.(ctx, createMockModelRequest(), async () => MOCK_RESPONSE);

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("handoff:injected");
    });

    test("does not inject same envelope twice (per-envelope tracking)", async () => {
      store.put(createTestEnvelope());
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();

      // First call — injects
      await mw.wrapModelCall?.(ctx, createMockModelRequest(), async () => MOCK_RESPONSE);

      // Second call with same envelope — passes through
      let passedRequest: ModelRequest | undefined;
      const request2 = createMockModelRequest();
      await mw.wrapModelCall?.(ctx, request2, async (req) => {
        passedRequest = req;
        return MOCK_RESPONSE;
      });

      expect(passedRequest?.messages.length).toBe(1); // No system message prepended
    });

    test("injects again when a new handoff envelope arrives", async () => {
      store.put(createTestEnvelope());
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();

      // First handoff — injects and transitions to "injected"
      await mw.wrapModelCall?.(ctx, createMockModelRequest(), async () => MOCK_RESPONSE);
      expect(events).toHaveLength(1);

      // Complete the first handoff lifecycle (accepted → no longer pending)
      store.transition(handoffId("hoff-1"), "injected", "accepted");

      // Simulate a second handoff with a different envelope ID
      store.put(
        createTestEnvelope({
          id: handoffId("hoff-2"),
          phase: { completed: "Report generated", next: "Review findings" },
        }),
      );

      // Second handoff — should also inject (new pending envelope)
      let passedRequest: ModelRequest | undefined;
      await mw.wrapModelCall?.(ctx, createMockModelRequest(), async (req) => {
        passedRequest = req;
        return MOCK_RESPONSE;
      });

      expect(passedRequest?.messages.length).toBe(2); // System message prepended
      expect(events).toHaveLength(2);
    });

    test("passes through when no pending envelope", async () => {
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();
      const request = createMockModelRequest();

      let passedRequest: ModelRequest | undefined;
      await mw.wrapModelCall?.(ctx, request, async (req) => {
        passedRequest = req;
        return MOCK_RESPONSE;
      });

      expect(passedRequest).toBe(request); // Same reference — no modification
    });
  });

  describe("wrapModelStream", () => {
    test("injects summary into first streaming call", async () => {
      store.put(createTestEnvelope());
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();
      const request = createMockModelRequest();

      let passedRequest: ModelRequest | undefined;
      const next = async function* (req: ModelRequest) {
        passedRequest = req;
        yield { kind: "done" as const, response: MOCK_RESPONSE };
      };

      const chunks = [];
      const stream = mw.wrapModelStream;
      if (stream === undefined) throw new Error("wrapModelStream must be defined");
      for await (const chunk of stream(ctx, request, next)) {
        chunks.push(chunk);
      }

      expect(passedRequest?.messages.length).toBe(2);
      expect(chunks).toHaveLength(1);
    });

    test("passes through on second streaming call", async () => {
      store.put(createTestEnvelope());
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();

      const stream = mw.wrapModelStream;
      if (stream === undefined) throw new Error("wrapModelStream must be defined");

      // First call
      for await (const _ of stream(ctx, createMockModelRequest(), async function* () {
        yield { kind: "done" as const, response: MOCK_RESPONSE };
      })) {
        /* drain */
      }

      // Second call
      let passedRequest: ModelRequest | undefined;
      const request2 = createMockModelRequest();
      for await (const _ of stream(ctx, request2, async function* (req) {
        passedRequest = req;
        yield { kind: "done" as const, response: MOCK_RESPONSE };
      })) {
        /* drain */
      }

      expect(passedRequest?.messages.length).toBe(1); // No injection
    });
  });

  describe("describeCapabilities", () => {
    test("returns capability fragment when envelope exists", () => {
      store.put(createTestEnvelope());
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();

      const fragment = mw.describeCapabilities?.(ctx);
      expect(fragment).toBeDefined();
      expect(fragment?.label).toBe("handoff");
      expect(fragment?.description).toContain("Generate report");
      expect(fragment?.description).toContain("accept_handoff");
    });

    test("returns undefined when no envelope", () => {
      const mw = makeMiddleware();
      const ctx = createMockTurnContext();

      expect(mw.describeCapabilities?.(ctx)).toBeUndefined();
    });
  });

  test("middleware has correct name and priority", () => {
    const mw = makeMiddleware();
    expect(mw.name).toBe("koi:handoff");
    expect(mw.priority).toBe(400);
  });
});
