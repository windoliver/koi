/**
 * Advanced hydrator tests: custom estimator, single-source-exceeds-budget,
 * freeze-on-first-hydrate, refresh, custom resolver, compactor,
 * refresh failure warnings, getHydrationResult accessor.
 */

import { describe, expect, test } from "bun:test";
import type { CompactionResult, ContextCompactor, TokenEstimator } from "@koi/core";
import { runId, sessionId } from "@koi/core";
import { createMockAgent, createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import type { ContextHydratorMiddleware } from "./hydrator.js";
import { createContextHydrator } from "./hydrator.js";
import type { ContextManifestConfig, SourceResolver, SourceResult } from "./types.js";

describe("createContextHydrator — custom estimator (9A)", () => {
  test("custom sync estimator is used instead of heuristic", async () => {
    const agent = createMockAgent();
    // Custom estimator that counts words, not chars/4
    const wordEstimator: TokenEstimator = {
      estimateText(text: string): number {
        return text.split(/\s+/).filter(Boolean).length;
      },
      estimateMessages(): number {
        return 0;
      },
    };

    const config: ContextManifestConfig = {
      maxTokens: 3, // 3 "tokens" = 3 words max
      sources: [
        { kind: "text", text: "one two", label: "Fits", priority: 1 }, // 2 words
        { kind: "text", text: "three four five six", label: "Dropped", priority: 2 }, // 4 words, over budget
      ],
    };
    const mw = createContextHydrator({ config, agent, estimator: wordEstimator });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("one two");
    expect(textBlock.text).not.toContain("three four five six");
  });

  test("async estimator works (returns Promise<number>)", async () => {
    const agent = createMockAgent();
    const asyncEstimator: TokenEstimator = {
      async estimateText(text: string): Promise<number> {
        return Math.ceil(text.length / 4);
      },
      async estimateMessages(): Promise<number> {
        return 0;
      },
    };

    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "async test content", label: "Async" }],
    };
    const mw = createContextHydrator({ config, agent, estimator: asyncEstimator });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("async test content");
  });

  test("estimator error propagates as rejection", async () => {
    const agent = createMockAgent();
    const failEstimator: TokenEstimator = {
      estimateText(): number {
        throw new Error("estimator broke");
      },
      estimateMessages(): number {
        return 0;
      },
    };

    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "fail", label: "Fail" }],
    };
    const mw = createContextHydrator({ config, agent, estimator: failEstimator });

    await expect(
      mw.onSessionStart?.({
        agentId: "a",
        sessionId: sessionId("s"),
        runId: runId("r"),
        metadata: {},
      }),
    ).rejects.toThrow("estimator broke");
  });
});

describe("createContextHydrator — single-source-exceeds-budget (10A)", () => {
  test("single source exceeding global budget is truncated, not dropped", async () => {
    const agent = createMockAgent();
    // 1000 chars = 250 tokens, budget = 25 tokens = 100 chars
    const config: ContextManifestConfig = {
      maxTokens: 25,
      sources: [{ kind: "text", text: "x".repeat(1000), label: "Big Source" }],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    // Should still have a system message (not dropped entirely)
    expect(spy.calls[0]?.messages).toHaveLength(1);
    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    // Contains truncated content
    expect(textBlock.text).toContain("x".repeat(50));
    expect(textBlock.text).toContain("[Content truncated");
  });
});

describe("createContextHydrator — freeze-on-first-hydrate (1A)", () => {
  test("calling onSessionStart twice throws", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "hi" }],
    };
    const mw = createContextHydrator({ config, agent });

    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    await expect(
      mw.onSessionStart?.({
        agentId: "a",
        sessionId: sessionId("s"),
        runId: runId("r"),
        metadata: {},
      }),
    ).rejects.toThrow("Context already hydrated");
  });
});

describe("createContextHydrator — refresh (2A)", () => {
  test("no refresh when refreshInterval not set", async () => {
    const agent = createMockAgent();
    let resolveCount = 0;
    const trackingResolver: SourceResolver = (_source, _agent): SourceResult => {
      resolveCount++;
      return {
        label: "Tracked",
        content: `call-${resolveCount}`,
        tokens: 0,
        source: { kind: "text" as const, text: "" },
      };
    };

    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "initial" }],
      // No refreshInterval
    };
    const mw = createContextHydrator({
      config,
      agent,
      resolvers: new Map([["text", trackingResolver]]),
    });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    // Call onBeforeTurn multiple times — should NOT re-resolve
    const resolveCountAfterInit = resolveCount;
    await mw.onBeforeTurn?.(createMockTurnContext({ turnIndex: 5 }));
    await mw.onBeforeTurn?.(createMockTurnContext({ turnIndex: 10 }));
    expect(resolveCount).toBe(resolveCountAfterInit);
  });

  test("refresh triggers at correct interval with updated refreshable source", async () => {
    const agent = createMockAgent();
    let callCount = 0;

    const dynamicResolver: SourceResolver = (_source, _agent): SourceResult => {
      callCount++;
      return {
        label: "Dynamic",
        content: `version-${callCount}`,
        tokens: 0,
        source: { kind: "text" as const, text: "", refreshable: true },
      };
    };

    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "", label: "Dynamic", refreshable: true }],
      refreshInterval: 3,
    };
    const mw = createContextHydrator({
      config,
      agent,
      resolvers: new Map([["text", dynamicResolver]]),
    });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });
    expect(callCount).toBe(1);

    // Turn 1: no refresh (1 % 3 !== 0)
    await mw.onBeforeTurn?.(createMockTurnContext({ turnIndex: 1 }));
    expect(callCount).toBe(1);

    // Turn 3: refresh (3 % 3 === 0)
    await mw.onBeforeTurn?.(createMockTurnContext({ turnIndex: 3 }));
    expect(callCount).toBe(2);

    // Verify content was updated
    const ctx = createMockTurnContext({ turnIndex: 3 });
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("version-2");
  });

  test("static (non-refreshable) sources preserved across refresh", async () => {
    const agent = createMockAgent();
    let dynamicCallCount = 0;

    const staticResolver: SourceResolver = (_source, _agent): SourceResult => ({
      label: "Static",
      content: "static-content",
      tokens: 0,
      source: { kind: "text" as const, text: "static-content" },
    });

    const dynamicResolver: SourceResolver = (_source, _agent): SourceResult => {
      dynamicCallCount++;
      return {
        label: "Dynamic",
        content: `dynamic-v${dynamicCallCount}`,
        tokens: 0,
        source: { kind: "file" as const, path: ".", refreshable: true },
      };
    };

    const config: ContextManifestConfig = {
      sources: [
        { kind: "text", text: "static-content", label: "Static", priority: 1 },
        { kind: "file", path: ".", label: "Dynamic", refreshable: true, priority: 2 },
      ],
      refreshInterval: 2,
    };
    const mw = createContextHydrator({
      config,
      agent,
      resolvers: new Map<string, SourceResolver>([
        ["text", staticResolver],
        ["file", dynamicResolver],
      ]),
    });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    // Trigger refresh at turn 2
    await mw.onBeforeTurn?.(createMockTurnContext({ turnIndex: 2 }));

    const ctx = createMockTurnContext({ turnIndex: 2 });
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    // Static source still present
    expect(textBlock.text).toContain("static-content");
    // Dynamic source updated
    expect(textBlock.text).toContain("dynamic-v2");
  });
});

describe("createContextHydrator — custom resolver (3A)", () => {
  test("custom resolver for new kind is called and content included", async () => {
    const agent = createMockAgent();

    const apiResolver: SourceResolver = (source, _agent): SourceResult => ({
      label: source.label ?? "API",
      content: "api-response-data",
      tokens: 0,
      source,
    });

    // Use "text" kind but with a custom resolver that overrides default
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "ignored by custom resolver", label: "Custom API" }],
    };
    const mw = createContextHydrator({
      config,
      agent,
      resolvers: new Map([["text", apiResolver]]),
    });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("api-response-data");
    expect(textBlock.text).not.toContain("ignored by custom resolver");
  });
});

describe("createContextHydrator — compactor (4A)", () => {
  test("compactor reduces oversized source to fit → included", async () => {
    const agent = createMockAgent();

    const mockCompactor: ContextCompactor = {
      compact(_messages, _maxTokens): CompactionResult {
        // Simulate compaction: return shorter text
        return {
          messages: [
            {
              content: [{ kind: "text", text: "compacted" }],
              senderId: "system:context",
              timestamp: Date.now(),
            },
          ],
          originalTokens: 100,
          compactedTokens: 3,
          strategy: "mock",
        };
      },
    };

    const config: ContextManifestConfig = {
      maxTokens: 15, // First source takes ~10, second would be ~10 (over budget)
      sources: [
        { kind: "text", text: "a".repeat(40), label: "First", priority: 1 }, // 10 tokens
        { kind: "text", text: "b".repeat(40), label: "Oversized", priority: 2 }, // 10 tokens — over
      ],
    };
    const mw = createContextHydrator({ config, agent, compactor: mockCompactor });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    // First source included
    expect(textBlock.text).toContain("a".repeat(40));
    // Second source compacted and included
    expect(textBlock.text).toContain("compacted");
    // Not dropped
    expect(textBlock.text).not.toContain("dropped due to token budget");
  });

  test("compactor cannot reduce enough → source dropped", async () => {
    const agent = createMockAgent();

    const failCompactor: ContextCompactor = {
      compact(_messages, _maxTokens): CompactionResult {
        // Return text that's still too large (simulates insufficient compaction)
        return {
          messages: [
            {
              content: [{ kind: "text", text: "still-too-large".repeat(50) }],
              senderId: "system:context",
              timestamp: Date.now(),
            },
          ],
          originalTokens: 100,
          compactedTokens: 50,
          strategy: "mock",
        };
      },
    };

    const config: ContextManifestConfig = {
      maxTokens: 12, // 12 tokens
      sources: [
        { kind: "text", text: "a".repeat(40), label: "First", priority: 1 }, // 10 tokens
        { kind: "text", text: "b".repeat(400), label: "HugeSource", priority: 2 }, // 100 tokens
      ],
    };
    const mw = createContextHydrator({ config, agent, compactor: failCompactor });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("a".repeat(40));
    // Oversized source dropped even after compaction attempt
    expect(textBlock.text).toContain("dropped due to token budget");
    expect(textBlock.text).toContain("HugeSource");
  });
});

describe("createContextHydrator — refresh failure warnings", () => {
  test("failed refreshable source emits warning and keeps stale cached version", async () => {
    const agent = createMockAgent();
    let callCount = 0;

    const flakyResolver: SourceResolver = (_source, _agent): SourceResult => {
      callCount++;
      if (callCount > 1) {
        throw new Error("network timeout");
      }
      return {
        label: "Flaky",
        content: "initial-content",
        tokens: 0,
        source: { kind: "text" as const, text: "", refreshable: true },
      };
    };

    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "", label: "Flaky", refreshable: true }],
      refreshInterval: 2,
    };
    const mw = createContextHydrator({
      config,
      agent,
      resolvers: new Map([["text", flakyResolver]]),
    });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    // First hydration succeeds
    const resultBefore = (mw as ContextHydratorMiddleware).getHydrationResult();
    expect(resultBefore?.warnings).toHaveLength(0);

    // Turn 2: refresh triggers but resolver throws
    await mw.onBeforeTurn?.(createMockTurnContext({ turnIndex: 2 }));

    // Warning should be recorded
    const resultAfter = (mw as ContextHydratorMiddleware).getHydrationResult();
    expect(resultAfter?.warnings).toHaveLength(1);
    expect(resultAfter?.warnings[0]).toContain("Refresh failed");
    expect(resultAfter?.warnings[0]).toContain("network timeout");
    expect(resultAfter?.warnings[0]).toContain("stale cached version kept");

    // Stale content should still be served
    const ctx = createMockTurnContext({ turnIndex: 2 });
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("initial-content");
  });
});

describe("createContextHydrator — getHydrationResult accessor", () => {
  test("returns undefined before hydration", () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "hello" }],
    };
    const mw = createContextHydrator({ config, agent });
    expect(mw.getHydrationResult()).toBeUndefined();
  });

  test("returns hydration result after onSessionStart", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [
        { kind: "text", text: "source-one", label: "One" },
        { kind: "text", text: "source-two", label: "Two" },
      ],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const result = mw.getHydrationResult();
    expect(result).toBeDefined();
    expect(result?.sources).toHaveLength(2);
    expect(result?.content).toContain("source-one");
    expect(result?.content).toContain("source-two");
    expect(result?.totalTokens).toBeGreaterThan(0);
    expect(result?.warnings).toHaveLength(0);
  });

  test("reflects updated state after refresh", async () => {
    const agent = createMockAgent();
    let callCount = 0;

    const dynamicResolver: SourceResolver = (_source, _agent): SourceResult => {
      callCount++;
      return {
        label: "Dynamic",
        content: `v${callCount}`,
        tokens: 0,
        source: { kind: "text" as const, text: "", refreshable: true },
      };
    };

    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "", label: "Dynamic", refreshable: true }],
      refreshInterval: 1,
    };
    const mw = createContextHydrator({
      config,
      agent,
      resolvers: new Map([["text", dynamicResolver]]),
    });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const before = mw.getHydrationResult();
    expect(before?.content).toContain("v1");

    // Trigger refresh
    await mw.onBeforeTurn?.(createMockTurnContext({ turnIndex: 1 }));

    const after = mw.getHydrationResult();
    expect(after?.content).toContain("v2");
  });

  test("includes dropped source warnings", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      maxTokens: 5, // Only ~20 chars fit
      sources: [
        { kind: "text", text: "fits", label: "Small", priority: 1 },
        { kind: "text", text: "x".repeat(1000), label: "TooBig", priority: 2 },
      ],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const result = mw.getHydrationResult();
    expect(result?.sources).toHaveLength(1);
    expect(result?.warnings.length).toBeGreaterThan(0);
    expect(result?.warnings.some((w) => w.includes("TooBig"))).toBe(true);
  });
});
