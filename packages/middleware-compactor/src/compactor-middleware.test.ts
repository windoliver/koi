import { describe, expect, test } from "bun:test";
import type { CompactionResult } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";
import type { ModelResponse } from "@koi/core/middleware";
import {
  createMockSessionContext,
  createMockTurnContext,
  createSpyModelHandler,
} from "@koi/test-utils";
import { createCompactorMiddleware } from "./compactor-middleware.js";
import type { CompactionStore } from "./types.js";

function userMsg(text: string): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "user", timestamp: 1 };
}

function createMockSummarizer(summary = "Test summary") {
  return async (): Promise<ModelResponse> => ({
    content: summary,
    model: "test-model",
  });
}

function overflowError(): Error & { readonly code: string } {
  return Object.assign(new Error("context too long"), {
    code: "context_length_exceeded",
  } as const);
}

describe("createCompactorMiddleware", () => {
  const ctx = createMockTurnContext();

  test("has name 'koi:compactor'", () => {
    const mw = createCompactorMiddleware({
      summarizer: createMockSummarizer(),
    });
    expect(mw.name).toBe("koi:compactor");
  });

  test("has priority 225", () => {
    const mw = createCompactorMiddleware({
      summarizer: createMockSummarizer(),
    });
    expect(mw.priority).toBe(225);
  });

  test("wrapModelCall passes compacted messages when threshold exceeded", async () => {
    const mw = createCompactorMiddleware({
      summarizer: createMockSummarizer("Compacted"),
      contextWindowSize: 1000,
      trigger: { messageCount: 3 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const messages = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

    const passedMessages = spy.calls[0]?.messages;
    expect(passedMessages).toBeDefined();
    // First message should be the summary
    expect(passedMessages?.[0]?.senderId).toBe("system:compactor");
    // Fewer messages than original
    expect(passedMessages?.length).toBeLessThan(messages.length);
  });

  test("wrapModelCall passes through when below threshold", async () => {
    const mw = createCompactorMiddleware({
      summarizer: createMockSummarizer(),
      trigger: { messageCount: 100 },
    });

    const messages = [userMsg("a"), userMsg("b")];
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

    // Same reference — no compaction
    expect(spy.calls[0]?.messages).toBe(messages);
  });

  test("wrapModelStream passes compacted messages", async () => {
    const mw = createCompactorMiddleware({
      summarizer: createMockSummarizer("Streamed summary"),
      contextWindowSize: 1000,
      trigger: { messageCount: 3 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const messages = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];

    let capturedMessages: readonly InboundMessage[] | undefined;
    const wrappingHandler = async function* (req: {
      readonly messages: readonly InboundMessage[];
    }) {
      capturedMessages = req.messages;
      yield { kind: "done" as const, response: { content: "ok", model: "test" } };
    };

    if (mw.wrapModelStream !== undefined) {
      for await (const _chunk of mw.wrapModelStream(ctx, { messages }, wrappingHandler)) {
        /* drain */
      }
    }

    expect(capturedMessages).toBeDefined();
    expect(capturedMessages?.[0]?.senderId).toBe("system:compactor");
  });

  test("wrapModelStream passes through below threshold", async () => {
    const mw = createCompactorMiddleware({
      summarizer: createMockSummarizer(),
      trigger: { messageCount: 100 },
    });

    const messages = [userMsg("a")];
    let capturedMessages: readonly InboundMessage[] | undefined;
    const wrappingHandler = async function* (req: {
      readonly messages: readonly InboundMessage[];
    }) {
      capturedMessages = req.messages;
      yield { kind: "done" as const, response: { content: "ok", model: "test" } };
    };

    if (mw.wrapModelStream !== undefined) {
      for await (const _chunk of mw.wrapModelStream(ctx, { messages }, wrappingHandler)) {
        /* drain */
      }
    }

    expect(capturedMessages).toBe(messages);
  });

  describe("overflow recovery", () => {
    test("wrapModelCall retries after context overflow", async () => {
      let callCount = 0;
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Compact"),
        contextWindowSize: 1000,
        trigger: { messageCount: 100 }, // Won't trigger normally
        preserveRecent: 1,
        maxSummaryTokens: 100,
        overflowRecovery: { maxRetries: 1 },
      });

      const messages = [userMsg("a"), userMsg("b"), userMsg("c")];
      const next = async (): Promise<ModelResponse> => {
        callCount++;
        if (callCount === 1) throw overflowError();
        return { content: "ok", model: "test" };
      };

      const result = await mw.wrapModelCall?.(ctx, { messages }, next);
      expect(result?.content).toBe("ok");
      expect(callCount).toBe(2);
    });

    test("wrapModelCall rethrows non-overflow errors", async () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Compact"),
        overflowRecovery: { maxRetries: 1 },
      });

      const messages = [userMsg("a")];
      const next = async (): Promise<ModelResponse> => {
        throw new Error("network failure");
      };

      await expect(mw.wrapModelCall?.(ctx, { messages }, next)).rejects.toThrow("network failure");
    });

    test("wrapModelStream retries after context overflow", async () => {
      let callCount = 0;
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Compact"),
        contextWindowSize: 1000,
        trigger: { messageCount: 100 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
        overflowRecovery: { maxRetries: 1 },
      });

      const messages = [userMsg("a"), userMsg("b"), userMsg("c")];
      const wrappingHandler = async function* () {
        callCount++;
        if (callCount === 1) throw overflowError();
        yield { kind: "done" as const, response: { content: "ok", model: "test" } };
      };

      const chunks: unknown[] = [];
      if (mw.wrapModelStream !== undefined) {
        for await (const chunk of mw.wrapModelStream(ctx, { messages }, wrappingHandler)) {
          chunks.push(chunk);
        }
      }
      expect(callCount).toBe(2);
      expect(chunks.length).toBe(1);
    });
  });

  describe("session restore", () => {
    test("onSessionStart loads from store and prepends to first model call", async () => {
      const summaryMsg: InboundMessage = {
        content: [{ kind: "text", text: "Previous summary" }],
        senderId: "system:compactor",
        timestamp: 1,
        metadata: { compacted: true },
      };
      const storedResult: CompactionResult = {
        messages: [summaryMsg],
        originalTokens: 100,
        compactedTokens: 20,
        strategy: "llm-summary",
      };

      const store: CompactionStore = {
        save: async () => {},
        load: async (sessionId) => {
          if (sessionId === "session-test-1") return storedResult;
          return undefined;
        },
      };

      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        trigger: { messageCount: 100 },
        store,
      });

      // Trigger onSessionStart
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      // First model call should have the summary prepended
      const messages = [userMsg("new message")];
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

      const passedMessages = spy.calls[0]?.messages;
      expect(passedMessages).toBeDefined();
      expect(passedMessages?.[0]?.senderId).toBe("system:compactor");
      expect(passedMessages?.length).toBe(2); // summary + new message
    });

    test("onSessionStart does not set restore when store returns undefined", async () => {
      const store: CompactionStore = {
        save: async () => {},
        load: async () => undefined,
      };

      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        trigger: { messageCount: 100 },
        store,
      });

      await mw.onSessionStart?.(createMockSessionContext());

      // Model call should pass through unmodified
      const messages = [userMsg("a")];
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
      expect(spy.calls[0]?.messages).toBe(messages);
    });

    test("no onSessionStart hook when store is not configured", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
      });
      expect(mw.onSessionStart).toBeUndefined();
    });

    test("store.save() called with ctx.session.sessionId after compaction", async () => {
      let savedSessionId: string | undefined;
      let savedResult: CompactionResult | undefined;
      const store: CompactionStore = {
        save: async (sessionId, result) => {
          savedSessionId = sessionId;
          savedResult = result;
        },
        load: async () => undefined,
      };

      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Saved summary"),
        contextWindowSize: 1000,
        trigger: { messageCount: 3 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
        store,
      });

      const messages = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

      expect(savedSessionId).toBe("session-test-1");
      expect(savedResult).toBeDefined();
      expect(savedResult?.strategy).toBe("llm-summary");
    });

    test("store.save() failure does not block model call", async () => {
      const store: CompactionStore = {
        save: async () => {
          throw new Error("store write failed");
        },
        load: async () => undefined,
      };

      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Summary"),
        contextWindowSize: 1000,
        trigger: { messageCount: 3 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
        store,
      });

      const messages = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
      const spy = createSpyModelHandler();
      // Should not throw despite store failure
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
      expect(spy.calls.length).toBe(1);
    });
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
      });
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns label 'compactor' and description containing 'compaction'", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
      });
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("compactor");
      expect(result?.description).toContain("compaction");
    });
  });
});
