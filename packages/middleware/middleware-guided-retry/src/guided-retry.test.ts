import { describe, expect, test } from "bun:test";
import type { BacktrackConstraint, ModelRequest, ModelResponse } from "@koi/core";
import { createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { createGuidedRetryMiddleware } from "./guided-retry.js";

const mockCtx = createMockTurnContext();

const baseConstraint: BacktrackConstraint = {
  reason: {
    kind: "validation_failure",
    message: "Output schema mismatch",
    timestamp: 1700000000000,
  },
  instructions: "Use strict JSON output",
};

const baseRequest: ModelRequest = {
  messages: [
    {
      senderId: "user-1",
      content: [{ kind: "text", text: "Hello" }],
      timestamp: 1700000000000,
    },
  ],
};

describe("createGuidedRetryMiddleware", () => {
  test("passthrough when no constraint is set", async () => {
    const handle = createGuidedRetryMiddleware({});
    const spy = createSpyModelHandler();

    const response = await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    expect(response).toBeDefined();
    expect(response?.content).toBe("mock response");
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.messages).toHaveLength(1);
  });

  test("injects system message when constraint is set", async () => {
    const handle = createGuidedRetryMiddleware({ initialConstraint: baseConstraint });
    const spy = createSpyModelHandler();

    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);

    expect(spy.calls).toHaveLength(1);
    // Original had 1 message, now should have 2 (system + original)
    expect(spy.calls[0]?.messages).toHaveLength(2);

    const firstCall = spy.calls[0];
    expect(firstCall).toBeDefined();
    const injected = firstCall?.messages[0];
    expect(injected).toBeDefined();
    expect(injected?.senderId).toBe("system:guided-retry");
    const block = injected?.content[0];
    expect(block?.kind).toBe("text");
    if (block?.kind === "text") {
      expect(block.text).toContain("validation_failure");
      expect(block.text).toContain("Use strict JSON output");
    }
  });

  test("constraint is consumed after maxInjections calls", async () => {
    const constraint: BacktrackConstraint = {
      ...baseConstraint,
      maxInjections: 3,
    };
    const handle = createGuidedRetryMiddleware({ initialConstraint: constraint });
    const spy = createSpyModelHandler();

    // Calls 1-3 should inject
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);

    expect(handle.hasConstraint()).toBe(false);

    // Call 4 should passthrough
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    expect(spy.calls).toHaveLength(4);
    expect(spy.calls[3]?.messages).toHaveLength(1); // No injection
  });

  test("constraint with default maxInjections (1) is consumed after single call", async () => {
    const constraint: BacktrackConstraint = {
      reason: {
        kind: "error",
        message: "Tool call failed",
        timestamp: 1700000000000,
      },
    };
    const handle = createGuidedRetryMiddleware({ initialConstraint: constraint });
    const spy = createSpyModelHandler();

    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    expect(handle.hasConstraint()).toBe(false);

    // Second call should passthrough
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    expect(spy.calls[1]?.messages).toHaveLength(1);
  });

  test("setConstraint / clearConstraint / hasConstraint handle API", () => {
    const handle = createGuidedRetryMiddleware({});

    expect(handle.hasConstraint()).toBe(false);

    handle.setConstraint(baseConstraint);
    expect(handle.hasConstraint()).toBe(true);

    handle.clearConstraint();
    expect(handle.hasConstraint()).toBe(false);
  });

  test("injected message is prepended (first in messages array)", async () => {
    const handle = createGuidedRetryMiddleware({ initialConstraint: baseConstraint });
    const spy = createSpyModelHandler();

    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);

    const messages = spy.calls[0]?.messages;
    expect(messages).toBeDefined();
    expect(messages?.[0]?.senderId).toBe("system:guided-retry");
    expect(messages?.[1]?.senderId).toBe("user-1");
  });

  test("model response is returned unchanged", async () => {
    const expectedResponse: ModelResponse = {
      content: "custom response",
      model: "test-model",
      usage: { inputTokens: 5, outputTokens: 10 },
    };
    const handle = createGuidedRetryMiddleware({ initialConstraint: baseConstraint });
    const handler = async (_req: ModelRequest): Promise<ModelResponse> => expectedResponse;

    const response = await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, handler);

    expect(response).toEqual(expectedResponse);
  });

  test("setConstraint resets remaining injections", async () => {
    const handle = createGuidedRetryMiddleware({});
    const spy = createSpyModelHandler();

    // Set constraint with maxInjections=2
    handle.setConstraint({ ...baseConstraint, maxInjections: 2 });

    // Use 1 injection
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    expect(handle.hasConstraint()).toBe(true);

    // Replace with new constraint (maxInjections=1)
    handle.setConstraint(baseConstraint);
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    expect(handle.hasConstraint()).toBe(false);
  });

  test("middleware has correct name and priority", () => {
    const handle = createGuidedRetryMiddleware({});
    expect(handle.middleware.name).toBe("guided-retry");
    expect(handle.middleware.priority).toBe(425);
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const handle = createGuidedRetryMiddleware({});
      expect(handle.middleware.describeCapabilities).toBeDefined();
    });

    test("returns label 'guided-retry' and description containing 'retry'", () => {
      const handle = createGuidedRetryMiddleware({});
      const result = handle.middleware.describeCapabilities?.(mockCtx);
      expect(result?.label).toBe("guided-retry");
      expect(result?.description).toContain("retry");
    });
  });
});
