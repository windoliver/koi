import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@koi/core";
import { createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { descriptor } from "./descriptor.js";

const mockCtx = createMockTurnContext();

describe("guided-retry descriptor", () => {
  test("factory forwards initialConstraint from options", async () => {
    const options: JsonObject = {
      initialConstraint: {
        reason: {
          kind: "validation_failure",
          message: "Schema mismatch",
          timestamp: 1700000000000,
        },
        instructions: "Use strict JSON output",
      },
    };

    const middleware = await descriptor.factory(options, {
      manifestDir: "/tmp",
      agentId: "test",
    } as never);

    // The middleware should inject the constraint into the first model call
    const spy = createSpyModelHandler();
    const request = {
      messages: [
        {
          senderId: "user-1",
          content: [{ kind: "text" as const, text: "Hello" }],
          timestamp: 1700000000000,
        },
      ],
    };

    await middleware.wrapModelCall?.(mockCtx, request, spy.handler);

    // Should have injected a system message (2 messages instead of 1)
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.messages).toHaveLength(2);
    const injected = spy.calls[0]?.messages[0];
    expect(injected?.senderId).toBe("system:guided-retry");
  });

  test("factory creates passthrough middleware when no initialConstraint", async () => {
    const middleware = await descriptor.factory({}, {
      manifestDir: "/tmp",
      agentId: "test",
    } as never);

    const spy = createSpyModelHandler();
    const request = {
      messages: [
        {
          senderId: "user-1",
          content: [{ kind: "text" as const, text: "Hello" }],
          timestamp: 1700000000000,
        },
      ],
    };

    await middleware.wrapModelCall?.(mockCtx, request, spy.handler);

    // No injection — passthrough
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.messages).toHaveLength(1);
  });

  test("factory ignores malformed initialConstraint", async () => {
    const options: JsonObject = {
      initialConstraint: "not-an-object",
    };

    const middleware = await descriptor.factory(options, {
      manifestDir: "/tmp",
      agentId: "test",
    } as never);

    const spy = createSpyModelHandler();
    const request = {
      messages: [
        {
          senderId: "user-1",
          content: [{ kind: "text" as const, text: "Hello" }],
          timestamp: 1700000000000,
        },
      ],
    };

    await middleware.wrapModelCall?.(mockCtx, request, spy.handler);

    // No injection — passthrough
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.messages).toHaveLength(1);
  });
});
