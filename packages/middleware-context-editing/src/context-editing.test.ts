import { describe, expect, test } from "bun:test";
import type { TokenEstimator } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";
import { createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { createContextEditingMiddleware } from "./context-editing.js";

/** Helper to create a tool result message. */
function toolMsg(toolName: string, text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "tool",
    timestamp: Date.now(),
    metadata: { toolName },
  };
}

/** Helper to create a user message. */
function userMsg(text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: Date.now(),
  };
}

describe("createContextEditingMiddleware", () => {
  const ctx = createMockTurnContext();

  test("wrapModelCall passes edited messages to next", async () => {
    const mw = createContextEditingMiddleware({
      triggerTokenCount: 10,
      numRecentToKeep: 1,
    });
    const messages: readonly InboundMessage[] = [
      toolMsg("search", "old tool result with plenty of text"),
      toolMsg("search", "another old result"),
      toolMsg("search", "recent result"),
    ];
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

    const passedMessages = spy.calls[0]?.messages;
    expect(passedMessages).toBeDefined();
    // First two should be cleared, last preserved
    expect(passedMessages?.[0]?.content).toEqual([{ kind: "text", text: "[cleared]" }]);
    expect(passedMessages?.[1]?.content).toEqual([{ kind: "text", text: "[cleared]" }]);
    expect(passedMessages?.[2]?.content).toEqual([{ kind: "text", text: "recent result" }]);
  });

  test("wrapModelStream passes edited messages to next", async () => {
    const mw = createContextEditingMiddleware({
      triggerTokenCount: 10,
      numRecentToKeep: 1,
    });
    const messages: readonly InboundMessage[] = [
      toolMsg("search", "old tool result with plenty of text"),
      toolMsg("search", "recent result"),
    ];

    // Capture what's passed to next
    let capturedMessages: readonly InboundMessage[] | undefined;
    const wrappingHandler = async function* (req: {
      readonly messages: readonly InboundMessage[];
    }) {
      capturedMessages = req.messages;
      yield { kind: "done" as const, response: { content: "hello", model: "test" } };
    };

    if (mw.wrapModelStream !== undefined) {
      // Drain the generator to trigger execution
      for await (const _chunk of mw.wrapModelStream(ctx, { messages }, wrappingHandler)) {
        /* drain */
      }
    }

    expect(capturedMessages?.[0]?.content).toEqual([{ kind: "text", text: "[cleared]" }]);
    expect(capturedMessages?.[1]?.content).toEqual([{ kind: "text", text: "recent result" }]);
  });

  test("default config works — no edits when below threshold", async () => {
    const mw = createContextEditingMiddleware();
    const messages: readonly InboundMessage[] = [
      userMsg("hello"),
      toolMsg("search", "short result"),
    ];
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
    // Messages below 100k threshold — passed through unchanged
    expect(spy.calls[0]?.messages).toBe(messages);
  });

  test("uses custom tokenEstimator when provided", async () => {
    let estimateCalled = false;
    const customEstimator: TokenEstimator = {
      estimateText(): number {
        return 0;
      },
      estimateMessages(): number {
        estimateCalled = true;
        // Return high count to trigger editing
        return 999_999;
      },
    };
    const mw = createContextEditingMiddleware({
      triggerTokenCount: 100,
      numRecentToKeep: 0,
      tokenEstimator: customEstimator,
    });
    const messages: readonly InboundMessage[] = [toolMsg("search", "result")];
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
    expect(estimateCalled).toBe(true);
    expect(spy.calls[0]?.messages?.[0]?.content).toEqual([{ kind: "text", text: "[cleared]" }]);
  });

  test("has priority 250", () => {
    const mw = createContextEditingMiddleware();
    expect(mw.priority).toBe(250);
  });

  test("has name 'koi:context-editing'", () => {
    const mw = createContextEditingMiddleware();
    expect(mw.name).toBe("koi:context-editing");
  });

  test("throws on negative triggerTokenCount", () => {
    expect(() => createContextEditingMiddleware({ triggerTokenCount: -1 })).toThrow(
      "triggerTokenCount must be non-negative",
    );
  });

  test("throws on negative numRecentToKeep", () => {
    expect(() => createContextEditingMiddleware({ numRecentToKeep: -1 })).toThrow(
      "numRecentToKeep must be non-negative",
    );
  });
});
