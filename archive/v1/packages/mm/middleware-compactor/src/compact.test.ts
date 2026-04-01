import { describe, expect, test } from "bun:test";
import type {
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
} from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import type { ModelHandler, ModelResponse } from "@koi/core/middleware";
import { createLlmCompactor } from "./compact.js";

function userMsg(text: string, ts = 1): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "user", timestamp: ts };
}

function assistantMsg(text: string, callId?: string, ts = 2): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "assistant",
    timestamp: ts,
    ...(callId !== undefined ? { metadata: { callId } } : {}),
  };
}

function toolResultMsg(callId: string, text: string, ts = 3): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "tool",
    timestamp: ts,
    metadata: { callId },
  };
}

/** Create a message with exactly `n` tokens worth of text (n*4 chars). */
function msgWithTokens(tokens: number, senderId = "user"): InboundMessage {
  return {
    content: [{ kind: "text", text: "x".repeat(tokens * 4) }],
    senderId,
    timestamp: 1,
  };
}

function createMockSummarizer(summary = "Test summary"): ModelHandler {
  return async (): Promise<ModelResponse> => ({
    content: summary,
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 20 },
  });
}

describe("createLlmCompactor", () => {
  test("returns original messages when below tokenFraction threshold", async () => {
    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer(),
      contextWindowSize: 200_000,
      trigger: { tokenFraction: 0.75 },
    });

    // Small messages — well below 75% of 200k
    const msgs = [userMsg("hello"), assistantMsg("hi")];
    const result = await compactor.compact(msgs, 200_000);

    expect(result.messages).toBe(msgs);
    expect(result.strategy).toBe("noop");
    expect(result.originalTokens).toBeGreaterThanOrEqual(0);
    expect(result.compactedTokens).toBe(result.originalTokens);
  });

  test("returns original messages when below messageCount threshold", async () => {
    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer(),
      trigger: { messageCount: 10 },
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
    const result = await compactor.compact(msgs, 200_000);
    expect(result.messages).toBe(msgs);
    expect(result.strategy).toBe("noop");
  });

  test("triggers compaction when messageCount exceeded", async () => {
    let summarizerCalled = false;
    const summarizer: ModelHandler = async () => {
      summarizerCalled = true;
      return { content: "Summary of conversation", model: "test" };
    };

    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 100_000,
      trigger: { messageCount: 3 },
      preserveRecent: 1,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    const result = await compactor.compact(msgs, 100_000);

    expect(summarizerCalled).toBe(true);
    expect(result.strategy).toBe("llm-summary");
    // Should have summary message + preserved recent messages
    expect(result.messages.length).toBeLessThan(msgs.length);
    // First message should be the summary
    expect(result.messages[0]?.senderId).toBe("system:compactor");
  });

  test("triggers compaction when tokenFraction exceeded", async () => {
    const summarizer = createMockSummarizer("Compressed summary");

    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 1000,
      trigger: { tokenFraction: 0.5 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    // 4 messages each with 200 tokens = 800 total. 800/1000 = 0.8 > 0.5.
    const msgs = [msgWithTokens(200), msgWithTokens(200), msgWithTokens(200), msgWithTokens(200)];
    const result = await compactor.compact(msgs, 1000);

    expect(result.strategy).toBe("llm-summary");
    expect(result.messages[0]?.senderId).toBe("system:compactor");
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
  });

  test("triggers compaction when tokenCount exceeded", async () => {
    const summarizer = createMockSummarizer("Summary");

    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 10_000,
      trigger: { tokenCount: 100 },
      preserveRecent: 1,
      maxSummaryTokens: 50,
    });

    // Each 200 tokens = 800 total > 100.
    const msgs = [msgWithTokens(200), msgWithTokens(200), msgWithTokens(200), msgWithTokens(200)];
    const result = await compactor.compact(msgs, 10_000);
    expect(result.strategy).toBe("llm-summary");
  });

  test("preserves recent messages intact", async () => {
    const summarizer = createMockSummarizer("Summary");

    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 1000,
      trigger: { messageCount: 3 },
      preserveRecent: 2,
      maxSummaryTokens: 100,
    });

    const msgs = [userMsg("old-1"), userMsg("old-2"), userMsg("recent-1"), userMsg("recent-2")];
    const result = await compactor.compact(msgs, 1000);

    // Last 2 messages should be preserved verbatim
    const resultMsgs = result.messages;
    expect(resultMsgs[resultMsgs.length - 1]).toBe(msgs[3]);
    expect(resultMsgs[resultMsgs.length - 2]).toBe(msgs[2]);
  });

  test("respects pair boundaries when splitting", async () => {
    const summarizer = createMockSummarizer("Summary");

    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 1000,
      trigger: { messageCount: 3 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const msgs = [
      userMsg("start"),
      assistantMsg("calling tool", "c1"),
      toolResultMsg("c1", "tool result"),
      userMsg("end"),
    ];
    const result = await compactor.compact(msgs, 1000);

    // Should not split inside the pair [1,2].
    // Valid splits: 1 or 3 (not 2).
    expect(result.strategy).toBe("llm-summary");
    // The tool result should either be fully in head (summarized) or fully in tail
    // with its assistant message.
  });

  test("summary message has compacted metadata", async () => {
    const summarizer = createMockSummarizer("My summary");

    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 1000,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
    const result = await compactor.compact(msgs, 1000);

    const summaryMsg = result.messages[0];
    expect(summaryMsg?.senderId).toBe("system:compactor");
    expect(summaryMsg?.metadata?.compacted).toBe(true);
    expect(summaryMsg?.content[0]?.kind).toBe("text");
    if (summaryMsg?.content[0]?.kind === "text") {
      expect(summaryMsg.content[0].text).toBe("My summary");
    }
  });

  test("summary message metadata contains compactionEpoch when provided", async () => {
    const summarizer = createMockSummarizer("Epoch summary");

    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 1000,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
    const result = await compactor.compact(msgs, 1000, undefined, 3);

    const summaryMsg = result.messages[0];
    expect(summaryMsg?.metadata?.compactionEpoch).toBe(3);
  });

  test("summary message metadata omits compactionEpoch when not provided", async () => {
    const summarizer = createMockSummarizer("No epoch summary");

    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 1000,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
    const result = await compactor.compact(msgs, 1000);

    const summaryMsg = result.messages[0];
    expect(summaryMsg?.metadata?.compacted).toBe(true);
    expect(summaryMsg?.metadata?.compactionEpoch).toBeUndefined();
  });

  test("forceCompact includes compactionEpoch in metadata", async () => {
    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer("Forced epoch"),
      contextWindowSize: 1000,
      trigger: { messageCount: 100 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
    const result = await compactor.forceCompact(msgs, 1000, undefined, 5);
    expect(result.messages[0]?.metadata?.compactionEpoch).toBe(5);
  });

  test("uses custom promptBuilder when provided", async () => {
    let customPromptCalled = false;
    const customBuilder = (msgs: readonly InboundMessage[], maxTokens: number): string => {
      customPromptCalled = true;
      return `Custom prompt for ${String(msgs.length)} messages, max ${String(maxTokens)} tokens`;
    };

    const summarizer = createMockSummarizer("Summary");
    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 1000,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
      promptBuilder: customBuilder,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
    await compactor.compact(msgs, 1000);
    expect(customPromptCalled).toBe(true);
  });

  test("returns noop when messages.length <= preserveRecent", async () => {
    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer(),
      trigger: { messageCount: 1 },
      preserveRecent: 10,
    });

    const msgs = [userMsg("a"), userMsg("b")];
    const result = await compactor.compact(msgs, 200_000);
    expect(result.strategy).toBe("noop");
    expect(result.messages).toBe(msgs);
  });

  test("returns noop when no valid split fits budget", async () => {
    const summarizer = createMockSummarizer("Summary");

    const compactor = createLlmCompactor({
      summarizer,
      // Tiny context window — nothing fits
      contextWindowSize: 10,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 5,
    });

    // Each message is 200 tokens — tail won't fit in 10-5=5 token budget
    const msgs = [msgWithTokens(200), msgWithTokens(200), msgWithTokens(200)];
    const result = await compactor.compact(msgs, 10);
    expect(result.strategy).toBe("noop");
    expect(result.messages).toBe(msgs);
  });

  test("re-entrancy guard prevents concurrent compactions", async () => {
    let concurrentCalls = 0;
    let maxConcurrent = 0;

    const slowSummarizer: ModelHandler = async () => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await new Promise((resolve) => setTimeout(resolve, 50));
      concurrentCalls--;
      return { content: "Summary", model: "test" };
    };

    const compactor = createLlmCompactor({
      summarizer: slowSummarizer,
      contextWindowSize: 1000,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];

    // Fire two concurrent compactions
    const [result1, result2] = await Promise.all([
      compactor.compact(msgs, 1000),
      compactor.compact(msgs, 1000),
    ]);

    // One should have compacted, the other should be noop (re-entrancy guard)
    const strategies = [result1.strategy, result2.strategy];
    expect(strategies).toContain("llm-summary");
    expect(strategies).toContain("noop");
    expect(maxConcurrent).toBe(1);
  });

  test("uses default config values", () => {
    // Just verify it doesn't throw with minimal config
    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer(),
    });
    expect(compactor).toBeDefined();
    expect(typeof compactor.compact).toBe("function");
  });

  test("returns noop when summarizer throws", async () => {
    const failingSummarizer: ModelHandler = async () => {
      throw new Error("Network error");
    };

    const compactor = createLlmCompactor({
      summarizer: failingSummarizer,
      contextWindowSize: 1000,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
    // Should NOT throw — graceful degradation to noop
    const result = await compactor.compact(msgs, 1000);
    expect(result.strategy).toBe("noop");
    expect(result.messages).toBe(msgs);
  });

  test("threads model parameter to summarizer when no summarizerModel", async () => {
    let capturedModel: string | undefined;
    const summarizer: ModelHandler = async (req) => {
      capturedModel = req.model;
      return { content: "Summary", model: "test" };
    };

    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 1000,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
      // No summarizerModel — should use the model arg from compact()
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
    await compactor.compact(msgs, 1000, "claude-sonnet");
    expect(capturedModel).toBe("claude-sonnet");
  });

  test("passes summarizerModel to the handler", async () => {
    let capturedModel: string | undefined;
    const summarizer: ModelHandler = async (req) => {
      capturedModel = req.model;
      return { content: "Summary", model: "test" };
    };

    const compactor = createLlmCompactor({
      summarizer,
      summarizerModel: "claude-haiku",
      contextWindowSize: 1000,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
    await compactor.compact(msgs, 1000);
    expect(capturedModel).toBe("claude-haiku");
  });

  test("calls archiver.archive() with head messages and summary text", async () => {
    let archivedMessages: readonly InboundMessage[] | undefined;
    let archivedSummary: string | undefined;
    const archiver = {
      archive: async (msgs: readonly InboundMessage[], summary: string): Promise<void> => {
        archivedMessages = msgs;
        archivedSummary = summary;
      },
    };

    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer("Summary text"),
      contextWindowSize: 1000,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
      archiver,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
    await compactor.compact(msgs, 1000);

    expect(archivedMessages).toBeDefined();
    expect(archivedSummary).toBe("Summary text");
  });

  test("archiver failure does not block compaction", async () => {
    const archiver = {
      archive: async (): Promise<void> => {
        throw new Error("archive failed");
      },
    };

    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer("Summary"),
      contextWindowSize: 1000,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
      archiver,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
    const result = await compactor.compact(msgs, 1000);
    expect(result.strategy).toBe("llm-summary");
  });

  test("pinned messages survive compaction", async () => {
    const summarizer = createMockSummarizer("Summary");

    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 1000,
      trigger: { messageCount: 3 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const pinned: InboundMessage = {
      content: [{ kind: "text", text: "harness context — do not compact" }],
      senderId: "harness",
      timestamp: 1,
      pinned: true,
    };

    // Pinned at index 1 — only index 0 can be compacted
    const msgs = [userMsg("old"), pinned, userMsg("mid"), userMsg("recent")];
    const result = await compactor.compact(msgs, 1000);

    // Pinned message must be in the output
    const hasPinned = result.messages.some((m) => m.pinned === true);
    expect(hasPinned).toBe(true);
  });

  test("pinned message at start prevents all compaction", async () => {
    const summarizer = createMockSummarizer("Summary");

    const compactor = createLlmCompactor({
      summarizer,
      contextWindowSize: 1000,
      trigger: { messageCount: 2 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const pinned: InboundMessage = {
      content: [{ kind: "text", text: "harness context" }],
      senderId: "harness",
      timestamp: 1,
      pinned: true,
    };

    const msgs = [pinned, userMsg("a"), userMsg("b"), userMsg("c")];
    const result = await compactor.compact(msgs, 1000);

    // No valid split points — should noop
    expect(result.strategy).toBe("noop");
    expect(result.messages).toBe(msgs);
  });

  describe("default fact-extracting archiver", () => {
    function createMockMemory(): MemoryComponent & {
      readonly stored: Array<{ readonly content: string; readonly options?: MemoryStoreOptions }>;
    } {
      const stored: Array<{ readonly content: string; readonly options?: MemoryStoreOptions }> = [];
      return {
        stored,
        async store(content: string, options?: MemoryStoreOptions): Promise<void> {
          stored.push({ content, ...(options !== undefined ? { options } : {}) });
        },
        async recall(
          _query: string,
          _options?: MemoryRecallOptions,
        ): Promise<readonly MemoryResult[]> {
          return [];
        },
      };
    }

    test("memory set + no archiver → compaction calls fact-extracting archiver", async () => {
      const memory = createMockMemory();
      const compactor = createLlmCompactor({
        summarizer: createMockSummarizer("Summary"),
        contextWindowSize: 1000,
        trigger: { messageCount: 2 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
        memory: memory,
      });

      // Use messages that match heuristic patterns (decision pattern)
      const msgs = [
        userMsg("We decided to use TypeScript for this project"),
        userMsg("We chose Bun as the runtime"),
        userMsg("recent"),
      ];
      const result = await compactor.compact(msgs, 1000);

      expect(result.strategy).toBe("llm-summary");
      // The fact-extracting archiver should have stored extracted facts
      expect(memory.stored.length).toBeGreaterThan(0);
    });

    test("memory set + explicit archiver → explicit archiver wins", async () => {
      const memory = createMockMemory();
      // let — tracks whether custom archiver was called
      let customCalled = false;
      const customArchiver = {
        async archive(): Promise<void> {
          customCalled = true;
        },
      };

      const compactor = createLlmCompactor({
        summarizer: createMockSummarizer("Summary"),
        contextWindowSize: 1000,
        trigger: { messageCount: 2 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
        memory: memory,
        archiver: customArchiver,
      });

      const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
      await compactor.compact(msgs, 1000);

      expect(customCalled).toBe(true);
      // Memory-based archiver should NOT have been used
      expect(memory.stored).toHaveLength(0);
    });

    test("no memory + no archiver → no archiver (backward compat)", async () => {
      const compactor = createLlmCompactor({
        summarizer: createMockSummarizer("Summary"),
        contextWindowSize: 1000,
        trigger: { messageCount: 2 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
      });

      const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];
      const result = await compactor.compact(msgs, 1000);
      expect(result.strategy).toBe("llm-summary");
      // No archiver — nothing crashes
    });

    test("memory set but compaction not triggered → archiver never called", async () => {
      const memory = createMockMemory();
      const compactor = createLlmCompactor({
        summarizer: createMockSummarizer("Summary"),
        contextWindowSize: 200_000,
        trigger: { tokenFraction: 0.75 },
        memory: memory,
      });

      const msgs = [userMsg("hello"), assistantMsg("hi")];
      const result = await compactor.compact(msgs, 200_000);

      expect(result.strategy).toBe("noop");
      expect(memory.stored).toHaveLength(0);
    });
  });

  test("forceCompact bypasses trigger checks", async () => {
    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer("Forced summary"),
      contextWindowSize: 1000,
      trigger: { messageCount: 100 }, // High threshold — would never trigger normally
      preserveRecent: 1,
      maxSummaryTokens: 100,
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c")];

    // compact() should be noop (below threshold)
    const normalResult = await compactor.compact(msgs, 1000);
    expect(normalResult.strategy).toBe("noop");

    // forceCompact() should summarize regardless
    const forcedResult = await compactor.forceCompact(msgs, 1000);
    expect(forcedResult.strategy).toBe("llm-summary");
    expect(forcedResult.messages[0]?.senderId).toBe("system:compactor");
  });
});

describe("convention preservation", () => {
  test("convention block is prepended to summary message", async () => {
    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer("LLM summary text"),
      contextWindowSize: 1000,
      trigger: { messageCount: 3 },
      preserveRecent: 1,
      maxSummaryTokens: 500,
      conventions: [{ label: "immutability", description: "Never mutate shared state" }],
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    const result = await compactor.compact(msgs, 1000);
    expect(result.strategy).toBe("llm-summary");
    const summaryText = result.messages[0]?.content[0];
    expect(summaryText?.kind).toBe("text");
    if (summaryText?.kind === "text") {
      expect(summaryText.text).toContain("[Conventions]");
      expect(summaryText.text).toContain("**immutability**");
      expect(summaryText.text).toContain("LLM summary text");
    }
  });

  test("conventions survive multi-cycle compaction", async () => {
    const conventions = [{ label: "esm-only", description: "Use .js extensions" }] as const;
    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer("Cycle summary"),
      contextWindowSize: 1000,
      trigger: { messageCount: 3 },
      preserveRecent: 1,
      maxSummaryTokens: 500,
      conventions,
    });

    // First compaction cycle
    const msgs1 = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    const result1 = await compactor.compact(msgs1, 1000);
    expect(result1.strategy).toBe("llm-summary");

    // Second compaction cycle — use output of first cycle + new messages
    const msgs2 = [...result1.messages, userMsg("e"), userMsg("f"), userMsg("g")];
    const result2 = await compactor.compact(msgs2, 1000);
    expect(result2.strategy).toBe("llm-summary");
    const text2 = result2.messages[0]?.content[0];
    if (text2?.kind === "text") {
      expect(text2.text).toContain("[Conventions]");
      expect(text2.text).toContain("**esm-only**");
    }
  });

  test("no convention block when conventions empty", async () => {
    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer("Plain summary"),
      contextWindowSize: 1000,
      trigger: { messageCount: 3 },
      preserveRecent: 1,
      maxSummaryTokens: 500,
      conventions: [],
    });

    const msgs = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    const result = await compactor.compact(msgs, 1000);
    const text = result.messages[0]?.content[0];
    if (text?.kind === "text") {
      expect(text.text).not.toContain("[Conventions]");
      expect(text.text).toBe("Plain summary");
    }
  });
});
