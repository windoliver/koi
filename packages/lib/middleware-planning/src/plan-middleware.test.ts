import { describe, expect, it } from "bun:test";
import type {
  CapabilityFragment,
  InboundMessage,
  JsonObject,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  SessionContext,
  SessionId,
  ToolDescriptor,
  TurnContext,
} from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";

import { createPlanMiddleware, type PlanItem, WRITE_PLAN_TOOL_NAME } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionCtx(sid?: SessionId): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: sid ?? sessionId("s1"),
    runId: runId("r1"),
    metadata: {},
  };
}

function makeTurnCtx(session: SessionContext, turnIndex = 0): TurnContext {
  return {
    session,
    turnIndex,
    turnId: turnId(runId("r1"), turnIndex),
    messages: [],
    metadata: {},
  };
}

function makeRequest(text: string): ModelRequest {
  return {
    messages: [
      {
        senderId: "user",
        timestamp: 0,
        content: [{ kind: "text", text }],
      },
    ] satisfies readonly InboundMessage[],
    model: "test-model",
  };
}

function makeResponse(content: string): ModelResponse {
  return { content, model: "test-model" };
}

// ---------------------------------------------------------------------------
// Factory + validation
// ---------------------------------------------------------------------------

describe("createPlanMiddleware — factory", () => {
  it("creates middleware with default config", () => {
    const mw = createPlanMiddleware();
    expect(mw.name).toBe("plan");
    expect(mw.priority).toBe(450);
  });

  it("accepts a custom priority", () => {
    const mw = createPlanMiddleware({ priority: 300 });
    expect(mw.priority).toBe(300);
  });

  it("throws on invalid priority", () => {
    expect(() => createPlanMiddleware({ priority: -1 })).toThrow();
  });

  it("throws on invalid onPlanUpdate", () => {
    expect(() =>
      createPlanMiddleware({ onPlanUpdate: "not-a-function" as unknown as never }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Model-call hook
// ---------------------------------------------------------------------------

describe("wrapModelCall — tool + prompt injection", () => {
  it("injects plan system message into request messages", async () => {
    const mw = createPlanMiddleware();
    const ctx = makeTurnCtx(makeSessionCtx());

    let captured: ModelRequest | undefined;
    await mw.wrapModelCall?.(ctx, makeRequest("hello"), async (req) => {
      captured = req;
      return makeResponse("ok");
    });

    expect(captured).toBeDefined();
    const firstMsg = captured?.messages[0];
    expect(firstMsg?.senderId).toBe("system:plan");
    expect((firstMsg?.content[0] as { text: string }).text).toContain("write_plan");
  });

  it("injects the write_plan tool descriptor", async () => {
    const mw = createPlanMiddleware();
    const ctx = makeTurnCtx(makeSessionCtx());

    let captured: readonly ToolDescriptor[] | undefined;
    await mw.wrapModelCall?.(ctx, makeRequest("hello"), async (req) => {
      captured = req.tools;
      return makeResponse("ok");
    });

    const writePlanTool = captured?.find((t) => t.name === WRITE_PLAN_TOOL_NAME);
    expect(writePlanTool).toBeDefined();
  });

  it("attaches currentPlan to response metadata", async () => {
    const mw = createPlanMiddleware();
    const ctx = makeTurnCtx(makeSessionCtx());

    const response = await mw.wrapModelCall?.(ctx, makeRequest("hello"), async () =>
      makeResponse("ok"),
    );
    expect(response?.metadata?.currentPlan).toBeDefined();
  });

  it("injects plan state message when a plan is active", async () => {
    const mw = createPlanMiddleware();
    const sessionCtx = makeSessionCtx();
    await mw.onSessionStart?.(sessionCtx);
    const ctx = makeTurnCtx(sessionCtx);

    await mw.onBeforeTurn?.(ctx);
    await mw.wrapToolCall?.(
      ctx,
      {
        toolId: WRITE_PLAN_TOOL_NAME,
        input: {
          plan: [{ content: "Step 1", status: "in_progress" }],
        } satisfies JsonObject,
      },
      async () => ({ output: "x" }),
    );

    await mw.onBeforeTurn?.(ctx);
    let captured: ModelRequest | undefined;
    await mw.wrapModelCall?.(ctx, makeRequest("continue"), async (req) => {
      captured = req;
      return makeResponse("ok");
    });

    const planStateText = (captured?.messages[1]?.content[0] as { text: string } | undefined)?.text;
    expect(planStateText).toContain("Current plan state");
    expect(planStateText).toContain("Step 1");
  });
});

// ---------------------------------------------------------------------------
// Stream hook
// ---------------------------------------------------------------------------

describe("wrapModelStream", () => {
  it("injects tools into the stream request and yields chunks", async () => {
    const mw = createPlanMiddleware();
    const ctx = makeTurnCtx(makeSessionCtx());

    async function* mockStream(req: ModelRequest): AsyncIterable<ModelChunk> {
      expect(req.tools?.some((t) => t.name === WRITE_PLAN_TOOL_NAME)).toBe(true);
      yield { kind: "text_delta", delta: "hi" };
    }

    const chunks: ModelChunk[] = [];
    const stream = mw.wrapModelStream?.(ctx, makeRequest("hi"), (req) => mockStream(req));
    if (stream !== undefined) {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    }
    expect(chunks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tool-call hook
// ---------------------------------------------------------------------------

describe("wrapToolCall — write_plan interception", () => {
  it("stores the plan and invokes onPlanUpdate", async () => {
    let capturedPlan: readonly PlanItem[] | undefined;
    const mw = createPlanMiddleware({
      onPlanUpdate: (plan) => {
        capturedPlan = plan;
      },
    });
    const sessionCtx = makeSessionCtx();
    await mw.onSessionStart?.(sessionCtx);
    const ctx = makeTurnCtx(sessionCtx);
    await mw.onBeforeTurn?.(ctx);

    const response = await mw.wrapToolCall?.(
      ctx,
      {
        toolId: WRITE_PLAN_TOOL_NAME,
        input: {
          plan: [
            { content: "Step 1", status: "pending" },
            { content: "Step 2", status: "in_progress" },
          ],
        } satisfies JsonObject,
      },
      async () => ({ output: "should not be called" }),
    );

    expect(response?.output).toContain("Plan updated");
    expect(capturedPlan).toHaveLength(2);
    expect(capturedPlan?.[0]?.content).toBe("Step 1");
  });

  it("passes through non-plan tool calls unchanged", async () => {
    const mw = createPlanMiddleware();
    const sessionCtx = makeSessionCtx();
    await mw.onSessionStart?.(sessionCtx);
    const ctx = makeTurnCtx(sessionCtx);
    const expected = { output: "tool result" };

    const response = await mw.wrapToolCall?.(
      ctx,
      { toolId: "other_tool", input: {} satisfies JsonObject },
      async () => expected,
    );
    expect(response).toBe(expected);
  });

  it("rejects a second write_plan call in the same turn", async () => {
    const mw = createPlanMiddleware();
    const sessionCtx = makeSessionCtx();
    await mw.onSessionStart?.(sessionCtx);
    const ctx = makeTurnCtx(sessionCtx);
    await mw.onBeforeTurn?.(ctx);

    const input = {
      plan: [{ content: "Step 1", status: "pending" }],
    } satisfies JsonObject;
    const request = { toolId: WRITE_PLAN_TOOL_NAME, input };

    const first = await mw.wrapToolCall?.(ctx, request, async () => ({ output: "x" }));
    expect(first?.output).toContain("Plan updated");

    const second = await mw.wrapToolCall?.(ctx, request, async () => ({ output: "x" }));
    expect((second?.output as Record<string, unknown>).error).toContain("once per response");
  });

  it("allows write_plan again after onBeforeTurn resets the counter", async () => {
    const mw = createPlanMiddleware();
    const sessionCtx = makeSessionCtx();
    await mw.onSessionStart?.(sessionCtx);
    const ctx = makeTurnCtx(sessionCtx);

    const input = {
      plan: [{ content: "Step 1", status: "pending" }],
    } satisfies JsonObject;
    const request = { toolId: WRITE_PLAN_TOOL_NAME, input };

    await mw.onBeforeTurn?.(ctx);
    const first = await mw.wrapToolCall?.(ctx, request, async () => ({ output: "x" }));
    expect(first?.output).toContain("Plan updated");

    await mw.onBeforeTurn?.(ctx);
    const second = await mw.wrapToolCall?.(ctx, request, async () => ({ output: "x" }));
    expect(second?.output).toContain("Plan updated");
  });

  it("returns an error for a non-array plan input", async () => {
    const mw = createPlanMiddleware();
    const sessionCtx = makeSessionCtx();
    await mw.onSessionStart?.(sessionCtx);
    const ctx = makeTurnCtx(sessionCtx);
    await mw.onBeforeTurn?.(ctx);

    const response = await mw.wrapToolCall?.(
      ctx,
      {
        toolId: WRITE_PLAN_TOOL_NAME,
        input: { plan: "not an array" } as unknown as JsonObject,
      },
      async () => ({ output: "x" }),
    );
    expect((response?.output as Record<string, unknown>).error).toBeDefined();
  });

  it("returns an error for a plan item with an invalid status", async () => {
    const mw = createPlanMiddleware();
    const sessionCtx = makeSessionCtx();
    await mw.onSessionStart?.(sessionCtx);
    const ctx = makeTurnCtx(sessionCtx);
    await mw.onBeforeTurn?.(ctx);

    const response = await mw.wrapToolCall?.(
      ctx,
      {
        toolId: WRITE_PLAN_TOOL_NAME,
        input: {
          plan: [{ content: "Step 1", status: "invalid" }],
        } satisfies JsonObject,
      },
      async () => ({ output: "x" }),
    );
    expect((response?.output as Record<string, unknown>).error).toContain("status");
  });

  it("atomically replaces the plan on each successful call", async () => {
    let callCount = 0;
    let lastCapturedPlan: readonly PlanItem[] | undefined;
    const mw = createPlanMiddleware({
      onPlanUpdate: (plan) => {
        callCount += 1;
        lastCapturedPlan = plan;
      },
    });
    const sessionCtx = makeSessionCtx();
    await mw.onSessionStart?.(sessionCtx);
    const ctx = makeTurnCtx(sessionCtx);

    await mw.onBeforeTurn?.(ctx);
    await mw.wrapToolCall?.(
      ctx,
      {
        toolId: WRITE_PLAN_TOOL_NAME,
        input: {
          plan: [
            { content: "A", status: "pending" },
            { content: "B", status: "pending" },
          ],
        } satisfies JsonObject,
      },
      async () => ({ output: "x" }),
    );

    await mw.onBeforeTurn?.(ctx);
    await mw.wrapToolCall?.(
      ctx,
      {
        toolId: WRITE_PLAN_TOOL_NAME,
        input: {
          plan: [{ content: "C", status: "completed" }],
        } satisfies JsonObject,
      },
      async () => ({ output: "x" }),
    );

    expect(callCount).toBe(2);
    expect(lastCapturedPlan).toHaveLength(1);
    expect(lastCapturedPlan?.[0]?.content).toBe("C");
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("describeCapabilities", () => {
  it("reports no active plan before any write_plan call", () => {
    const mw = createPlanMiddleware();
    const ctx = makeTurnCtx(makeSessionCtx());
    const fragment = mw.describeCapabilities(ctx) as CapabilityFragment;
    expect(fragment.label).toBe("planning");
    expect(fragment.description).toContain("no active plan");
  });

  it("reports active plan counts after write_plan", async () => {
    const mw = createPlanMiddleware();
    const sessionCtx = makeSessionCtx();
    await mw.onSessionStart?.(sessionCtx);
    const ctx = makeTurnCtx(sessionCtx);
    await mw.onBeforeTurn?.(ctx);

    await mw.wrapToolCall?.(
      ctx,
      {
        toolId: WRITE_PLAN_TOOL_NAME,
        input: {
          plan: [
            { content: "A", status: "in_progress" },
            { content: "B", status: "pending" },
          ],
        } satisfies JsonObject,
      },
      async () => ({ output: "x" }),
    );

    const fragment = mw.describeCapabilities(ctx) as CapabilityFragment;
    expect(fragment.description).toContain("Plan active");
    expect(fragment.description).toContain("2 items");
  });
});

// ---------------------------------------------------------------------------
// Session isolation
// ---------------------------------------------------------------------------

describe("session isolation", () => {
  it("keeps plan state separated between sessions", async () => {
    const mw = createPlanMiddleware();
    const sessionA = makeSessionCtx(sessionId("session-a"));
    const sessionB = makeSessionCtx(sessionId("session-b"));
    await mw.onSessionStart?.(sessionA);
    await mw.onSessionStart?.(sessionB);

    const ctxA = makeTurnCtx(sessionA);
    await mw.onBeforeTurn?.(ctxA);
    await mw.wrapToolCall?.(
      ctxA,
      {
        toolId: WRITE_PLAN_TOOL_NAME,
        input: {
          plan: [{ content: "A-only", status: "in_progress" }],
        } satisfies JsonObject,
      },
      async () => ({ output: "x" }),
    );

    const ctxB = makeTurnCtx(sessionB);
    const response = await mw.wrapModelCall?.(ctxB, makeRequest("hi"), async () =>
      makeResponse("ok"),
    );
    const plan = response?.metadata?.currentPlan as unknown as readonly PlanItem[];
    expect(plan).toHaveLength(0);
  });

  it("clears session state on onSessionEnd", async () => {
    const mw = createPlanMiddleware();
    const sessionCtx = makeSessionCtx();
    await mw.onSessionStart?.(sessionCtx);

    const ctx = makeTurnCtx(sessionCtx);
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapToolCall?.(
      ctx,
      {
        toolId: WRITE_PLAN_TOOL_NAME,
        input: {
          plan: [{ content: "Task", status: "pending" }],
        } satisfies JsonObject,
      },
      async () => ({ output: "x" }),
    );

    await mw.onSessionEnd?.(sessionCtx);

    const ctx2 = makeTurnCtx(sessionCtx, 1);
    const response = await mw.wrapToolCall?.(
      ctx2,
      {
        toolId: WRITE_PLAN_TOOL_NAME,
        input: {
          plan: [{ content: "After end", status: "pending" }],
        } satisfies JsonObject,
      },
      async () => ({ output: "x" }),
    );
    expect((response?.output as Record<string, unknown>).error).toBeDefined();
  });

  it("applies the once-per-turn quota per-session", async () => {
    const mw = createPlanMiddleware();
    const sessionA = makeSessionCtx(sessionId("session-a"));
    const sessionB = makeSessionCtx(sessionId("session-b"));
    await mw.onSessionStart?.(sessionA);
    await mw.onSessionStart?.(sessionB);

    const ctxA = makeTurnCtx(sessionA);
    const ctxB = makeTurnCtx(sessionB);
    await mw.onBeforeTurn?.(ctxA);
    await mw.onBeforeTurn?.(ctxB);

    const input = {
      plan: [{ content: "Step 1", status: "pending" }],
    } satisfies JsonObject;

    const firstA = await mw.wrapToolCall?.(
      ctxA,
      { toolId: WRITE_PLAN_TOOL_NAME, input },
      async () => ({ output: "x" }),
    );
    expect(firstA?.output).toContain("Plan updated");

    const firstB = await mw.wrapToolCall?.(
      ctxB,
      { toolId: WRITE_PLAN_TOOL_NAME, input },
      async () => ({ output: "x" }),
    );
    expect(firstB?.output).toContain("Plan updated");

    const secondA = await mw.wrapToolCall?.(
      ctxA,
      { toolId: WRITE_PLAN_TOOL_NAME, input },
      async () => ({ output: "x" }),
    );
    expect((secondA?.output as Record<string, unknown>).error).toContain("once per response");
  });
});
