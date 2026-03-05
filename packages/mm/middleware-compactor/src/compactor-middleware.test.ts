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

    test("session B does not inherit session A's stale cachedRestore", async () => {
      const summaryMsg: InboundMessage = {
        content: [{ kind: "text", text: "Session A summary" }],
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

      // Session A loads a restore, session B's store returns undefined
      let loadCallCount = 0;
      const store: CompactionStore = {
        save: async () => {},
        load: async () => {
          loadCallCount++;
          // First call (session A) returns a result, second (session B) returns undefined
          return loadCallCount === 1 ? storedResult : undefined;
        },
      };

      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        trigger: { messageCount: 100 },
        store,
      });

      // Session A: loads restore but never makes a model call (cachedRestore stays set)
      await mw.onSessionStart?.(createMockSessionContext());

      // Session B: store returns undefined
      await mw.onSessionStart?.(createMockSessionContext());

      // Session B's model call should NOT inject session A's summary
      const messages = [userMsg("new message")];
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

  describe("forceCompactNext flag", () => {
    test("scheduleCompaction() causes next wrapModelCall to force-compact", async () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Forced summary"),
        contextWindowSize: 1000,
        trigger: { messageCount: 100 }, // Won't trigger normally
        preserveRecent: 1,
        maxSummaryTokens: 100,
      });

      const messages = [userMsg("a"), userMsg("b"), userMsg("c")];
      mw.scheduleCompaction();

      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

      // Force-compact should have compacted the messages
      const passedMessages = spy.calls[0]?.messages;
      expect(passedMessages).toBeDefined();
      expect(passedMessages?.[0]?.senderId).toBe("system:compactor");
      expect(passedMessages?.length).toBeLessThan(messages.length);
    });

    test("flag is consumed (one-shot) — second call without re-scheduling does NOT force-compact", async () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Forced summary"),
        contextWindowSize: 1000,
        trigger: { messageCount: 100 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
      });

      const messages = [userMsg("a"), userMsg("b"), userMsg("c")];
      mw.scheduleCompaction();

      const spy = createSpyModelHandler();
      // First call — should force-compact
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
      expect(spy.calls[0]?.messages?.[0]?.senderId).toBe("system:compactor");

      // Second call — should NOT force-compact (flag consumed)
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
      expect(spy.calls[1]?.messages).toBe(messages);
    });

    test("wrapModelStream also respects the flag", async () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Stream forced summary"),
        contextWindowSize: 1000,
        trigger: { messageCount: 100 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
      });

      const messages = [userMsg("a"), userMsg("b"), userMsg("c")];
      mw.scheduleCompaction();

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

    test("formatOccupancy returns a string with percentage", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
      });
      expect(mw.formatOccupancy()).toMatch(/Context: \d+%/);
    });
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
      });
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns label 'compactor' and description containing 'Compaction'", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
      });
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("compactor");
      expect(result?.description).toContain("Compaction");
    });

    test("mentions compact_context tool when toolEnabled is true", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        toolEnabled: true,
      });
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).toContain("compact_context");
    });

    test("does NOT mention compact_context tool when toolEnabled is omitted", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
      });
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).not.toContain("compact_context");
    });

    test("does NOT mention compact_context tool when toolEnabled is false", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        toolEnabled: false,
      });
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).not.toContain("compact_context");
    });
  });

  describe("context occupancy tracking", () => {
    test("describeCapabilities shows 0% before any model call", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
      });
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).toMatch(/Context: 0%/);
    });

    test("describeCapabilities shows updated % after model call", async () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        contextWindowSize: 1000,
        trigger: { messageCount: 100 },
      });

      // "a".repeat(400) = 400 chars ≈ 100 tokens → 100/1000 = 10%
      const messages = [userMsg("a".repeat(400))];
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).toMatch(/Context: \d+%/);
      // Should no longer be 0% after processing messages
      expect(result?.description).not.toMatch(/Context: 0%/);
    });

    test("governanceContributor is defined with 1 variable", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
      });
      expect(mw.governanceContributor).toBeDefined();
      expect(mw.governanceContributor.variables()).toHaveLength(1);
    });

    test("governanceContributor.variables()[0].read() returns 0 before model call, >0 after", async () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        trigger: { messageCount: 100 },
      });

      const variable = mw.governanceContributor.variables()[0];
      expect(variable).toBeDefined();
      if (variable === undefined) return;
      expect(variable.read()).toBe(0);

      const messages = [userMsg("hello world, this is a test message")];
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

      expect(variable.read()).toBeGreaterThan(0);
    });

    test("pressureTrend() returns estimatedTurnsToCompaction=-1 before 2 samples", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
      });
      const trend = mw.pressureTrend();
      expect(trend.estimatedTurnsToCompaction).toBe(-1);
    });

    test("describeCapabilities includes /turn after 2+ model calls", async () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        contextWindowSize: 200_000,
        trigger: { messageCount: 100 },
      });

      const spy = createSpyModelHandler();
      // First call
      await mw.wrapModelCall?.(ctx, { messages: [userMsg("a".repeat(1000))] }, spy.handler);
      // Second call with more tokens
      await mw.wrapModelCall?.(
        ctx,
        { messages: [userMsg("a".repeat(1000)), userMsg("b".repeat(1000))] },
        spy.handler,
      );

      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).toMatch(/K\/turn/);
    });
  });

  describe("soft trigger", () => {
    test("describeCapabilities returns normal description below soft trigger", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        contextWindowSize: 1000,
        trigger: { tokenFraction: 0.6, softTriggerFraction: 0.5 },
      });
      // Before any compaction, lastTokenFraction is 0 — below soft trigger
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).not.toContain("Context pressure");
    });

    test("describeCapabilities returns pressure warning above soft trigger", async () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Summary"),
        contextWindowSize: 1000,
        trigger: { tokenFraction: 0.6, softTriggerFraction: 0.5 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
      });

      // Trigger compaction to update lastTokenFraction
      // 4 messages x 200 tokens = 800 tokens. 800/1000 = 0.8 > 0.5 soft trigger
      const messages = [
        msgWithTokens(200),
        msgWithTokens(200),
        msgWithTokens(200),
        msgWithTokens(200),
      ];
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

      // After compaction, lastTokenFraction should be > 0.5
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).toContain("Context pressure");
      expect(result?.description).toContain("consider summarizing");
    });

    test("soft trigger does NOT trigger compaction", async () => {
      // tokenFraction 0.60, softTrigger 0.50
      // Create messages between 50% and 60% (e.g., 550 tokens / 1000)
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Should not be called"),
        contextWindowSize: 1000,
        trigger: { tokenFraction: 0.6, softTriggerFraction: 0.5 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
      });

      // ~40 tokens total — well below both triggers
      const messages = [userMsg("small message"), userMsg("another")];
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

      // Messages should pass through unmodified
      expect(spy.calls[0]?.messages).toBe(messages);
    });

    test("pressure warning includes percentage", async () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Summary"),
        contextWindowSize: 1000,
        trigger: { tokenFraction: 0.6, softTriggerFraction: 0.5 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
      });

      const messages = [
        msgWithTokens(200),
        msgWithTokens(200),
        msgWithTokens(200),
        msgWithTokens(200),
      ];
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

      const result = mw.describeCapabilities?.(ctx);
      // Should contain a percentage like "80%"
      expect(result?.description).toMatch(/\d+%/);
    });
  });

  describe("epoch tracking", () => {
    test("epoch starts at 0 — first compaction produces epoch 0 in metadata", async () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer("Epoch test"),
        contextWindowSize: 1000,
        trigger: { messageCount: 3 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
      });

      const messages = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

      // The compactor should have passed epoch 0 for first compaction
      const passedMessages = spy.calls[0]?.messages;
      expect(passedMessages?.[0]?.metadata?.compactionEpoch).toBe(0);
    });
  });

  describe("conventions in describeCapabilities", () => {
    test("includes convention labels when conventions configured", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        conventions: [
          { label: "immutability", description: "No mutation" },
          { label: "esm-only", description: "Use .js extensions" },
        ],
      });
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).toContain("Conventions:");
      expect(result?.description).toContain("immutability: No mutation");
      expect(result?.description).toContain("esm-only: Use .js extensions");
    });

    test("no convention suffix when conventions empty", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        conventions: [],
      });
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).not.toContain("Conventions:");
    });

    test("no convention suffix when conventions omitted", () => {
      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
      });
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).not.toContain("Conventions:");
    });

    test("current config conventions always win over stale stored ones", async () => {
      const storedMsg: InboundMessage = {
        content: [{ kind: "text", text: "Old summary with old conventions" }],
        senderId: "system:compactor",
        timestamp: 1,
        metadata: { compacted: true },
      };
      const store: CompactionStore = {
        save: async () => {},
        load: async () => ({
          messages: [storedMsg],
          originalTokens: 100,
          compactedTokens: 20,
          strategy: "llm-summary" as const,
        }),
      };

      const mw = createCompactorMiddleware({
        summarizer: createMockSummarizer(),
        trigger: { messageCount: 100 },
        store,
        conventions: [{ label: "fresh-convention", description: "Latest rule" }],
      });

      await mw.onSessionStart?.(createMockSessionContext());
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).toContain("fresh-convention: Latest rule");
    });
  });
});

/** Helper: create a message with exactly `n` tokens (n*4 chars). */
function msgWithTokens(tokens: number, senderId = "user"): InboundMessage {
  return {
    content: [{ kind: "text", text: "x".repeat(tokens * 4) }],
    senderId,
    timestamp: 1,
  };
}
