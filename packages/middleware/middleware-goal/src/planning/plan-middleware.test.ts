import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@koi/core/common";
import type { ToolDescriptor } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type {
  CapabilityFragment,
  ModelChunk,
  ModelRequest,
  ModelResponse,
} from "@koi/core/middleware";
import { createMockTurnContext, testMiddlewareContract } from "@koi/test-utils";
import { createPlanMiddleware } from "./plan-middleware.js";
import { WRITE_PLAN_TOOL_NAME } from "./plan-tool.js";
import type { PlanItem } from "./types.js";

function createRequest(text: string): ModelRequest {
  return {
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text" as const, text }],
      },
    ] satisfies readonly InboundMessage[],
    model: "test-model",
  };
}

function createResponse(content: string): ModelResponse {
  return { content, model: "test-model" };
}

describe("createPlanMiddleware", () => {
  test("creates middleware with default config", () => {
    const mw = createPlanMiddleware();
    expect(mw.name).toBe("plan");
    expect(mw.priority).toBe(450);
  });

  test("accepts custom priority", () => {
    const mw = createPlanMiddleware({ priority: 300 });
    expect(mw.priority).toBe(300);
  });

  test("throws on invalid config", () => {
    expect(() => createPlanMiddleware({ priority: -1 })).toThrow();
  });
});

describe("middleware contract", () => {
  testMiddlewareContract({
    createMiddleware: () => createPlanMiddleware(),
  });
});

describe("wrapModelCall — tool + prompt injection", () => {
  test("injects plan system message into request messages", async () => {
    const mw = createPlanMiddleware();
    const ctx = createMockTurnContext();

    // let justified: captured inside callback for inspection
    let capturedRequest: ModelRequest | undefined;
    await mw.wrapModelCall?.(ctx, createRequest("hello"), async (req) => {
      capturedRequest = req;
      return createResponse("ok");
    });

    expect(capturedRequest).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: validated by expect above
    const firstMsg = capturedRequest!.messages[0]!;
    expect(firstMsg.senderId).toBe("system:plan");
    expect((firstMsg.content[0] as { text: string }).text).toContain("write_plan");
  });

  test("injects write_plan tool descriptor", async () => {
    const mw = createPlanMiddleware();
    const ctx = createMockTurnContext();

    // let justified: captured inside callback for inspection
    let capturedTools: readonly ToolDescriptor[] | undefined;
    await mw.wrapModelCall?.(ctx, createRequest("hello"), async (req) => {
      capturedTools = req.tools;
      return createResponse("ok");
    });

    expect(capturedTools).toBeDefined();
    const writePlanTool = capturedTools?.find(
      (t: ToolDescriptor) => t.name === WRITE_PLAN_TOOL_NAME,
    );
    expect(writePlanTool).toBeDefined();
  });

  test("attaches currentPlan to response metadata", async () => {
    const mw = createPlanMiddleware();
    const ctx = createMockTurnContext();

    const response = await mw.wrapModelCall?.(ctx, createRequest("hello"), async () =>
      createResponse("ok"),
    );
    expect(response?.metadata).toBeDefined();
    expect(response?.metadata?.currentPlan).toBeDefined();
  });
});

describe("wrapModelStream — tool injection", () => {
  test("injects tools into stream request", async () => {
    const mw = createPlanMiddleware();
    const ctx = createMockTurnContext();

    async function* mockStream(req: ModelRequest): AsyncIterable<ModelChunk> {
      expect(req.tools).toBeDefined();
      yield { kind: "text_delta", delta: "hello" };
      yield { kind: "done", response: createResponse("hello") };
    }

    const chunks: ModelChunk[] = [];
    // biome-ignore lint/style/noNonNullAssertion: hook is guaranteed to exist on created middleware
    for await (const chunk of mw.wrapModelStream!(ctx, createRequest("hi"), (req) =>
      mockStream(req),
    )) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("wrapToolCall — write_plan interception", () => {
  test("intercepts write_plan calls and stores plan", async () => {
    // let justified: captured inside callback for inspection
    let capturedPlan: readonly PlanItem[] | undefined;
    const onPlanUpdate = (plan: readonly PlanItem[]): void => {
      capturedPlan = plan;
    };
    const mw = createPlanMiddleware({ onPlanUpdate });
    const ctx = createMockTurnContext();

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
    expect(capturedPlan).toBeDefined();
    expect(capturedPlan).toHaveLength(2);
    expect(capturedPlan?.[0]?.content).toBe("Step 1");
  });

  test("passes through non-plan tool calls", async () => {
    const mw = createPlanMiddleware();
    const ctx = createMockTurnContext();
    const expected = { output: "tool result" };

    const response = await mw.wrapToolCall?.(
      ctx,
      { toolId: "other_tool", input: {} satisfies JsonObject },
      async () => expected,
    );
    expect(response).toBe(expected);
  });

  test("rejects second write_plan call in same turn", async () => {
    const mw = createPlanMiddleware();
    const ctx = createMockTurnContext();

    // Reset per-turn counter
    await mw.onBeforeTurn?.(ctx);

    const input = {
      plan: [{ content: "Step 1", status: "pending" }],
    } satisfies JsonObject;
    const request = { toolId: WRITE_PLAN_TOOL_NAME, input };

    // First call succeeds
    const first = await mw.wrapToolCall?.(ctx, request, async () => ({ output: "x" }));
    expect(first?.output).toContain("Plan updated");

    // Second call in same turn fails
    const second = await mw.wrapToolCall?.(ctx, request, async () => ({ output: "x" }));
    expect((second?.output as Record<string, unknown>).error).toContain("once per response");
  });

  test("allows write_plan again after onBeforeTurn resets counter", async () => {
    const mw = createPlanMiddleware();
    const ctx = createMockTurnContext();

    const input = {
      plan: [{ content: "Step 1", status: "pending" }],
    } satisfies JsonObject;
    const request = { toolId: WRITE_PLAN_TOOL_NAME, input };

    await mw.onBeforeTurn?.(ctx);
    const first = await mw.wrapToolCall?.(ctx, request, async () => ({ output: "x" }));
    expect(first?.output).toContain("Plan updated");

    // New turn
    await mw.onBeforeTurn?.(ctx);
    const second = await mw.wrapToolCall?.(ctx, request, async () => ({ output: "x" }));
    expect(second?.output).toContain("Plan updated");
  });

  test("returns error for invalid plan input", async () => {
    const mw = createPlanMiddleware();
    const ctx = createMockTurnContext();
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

  test("returns error for plan items with invalid status", async () => {
    const mw = createPlanMiddleware();
    const ctx = createMockTurnContext();
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

  test("atomically replaces plan on each call", async () => {
    // let justified: captured plan from second call
    let lastCapturedPlan: readonly PlanItem[] | undefined;
    // let justified: tracks number of calls
    let callCount = 0;
    const onPlanUpdate = (plan: readonly PlanItem[]): void => {
      callCount += 1;
      lastCapturedPlan = plan;
    };
    const mw = createPlanMiddleware({ onPlanUpdate });
    const ctx = createMockTurnContext();

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

    // New turn — second plan replaces first
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
    expect(lastCapturedPlan).toBeDefined();
    expect(lastCapturedPlan).toHaveLength(1);
    expect(lastCapturedPlan?.[0]?.content).toBe("C");
  });
});

describe("plan persistence across turns", () => {
  test("plan state persists after wrapModelCall", async () => {
    const mw = createPlanMiddleware();
    const ctx = createMockTurnContext();

    // Turn 1: create plan
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

    // Turn 2: plan should be visible in metadata
    await mw.onBeforeTurn?.(ctx);
    const response = await mw.wrapModelCall?.(ctx, createRequest("continue"), async () =>
      createResponse("ok"),
    );

    const plan = response?.metadata?.currentPlan as unknown as Array<{ content: string }>;
    expect(plan).toHaveLength(1);
    expect(plan[0]?.content).toBe("Step 1");
  });
});

describe("describeCapabilities", () => {
  test("is defined on the middleware", () => {
    const mw = createPlanMiddleware();
    expect(mw.describeCapabilities).toBeDefined();
  });

  test("returns label 'planning' and description changes based on plan state", async () => {
    const mw = createPlanMiddleware();
    const ctx = createMockTurnContext();

    // Before any plan is written — no active plan
    const before = mw.describeCapabilities?.(ctx) as CapabilityFragment;
    expect(before.label).toBe("planning");
    expect(before.description).toContain("no active plan");

    // Write a plan to activate it
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapToolCall?.(
      ctx,
      {
        toolId: WRITE_PLAN_TOOL_NAME,
        input: {
          plan: [{ content: "Step 1", status: "pending" }],
        } satisfies JsonObject,
      },
      async () => ({ output: "x" }),
    );

    // After plan is written — active with item counts
    const after = mw.describeCapabilities?.(ctx) as CapabilityFragment;
    expect(after.label).toBe("planning");
    expect(after.description).toContain("Plan active");
  });
});
