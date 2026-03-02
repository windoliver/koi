import { describe, expect, test } from "bun:test";
import type { MemoryComponent, MemoryResult } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import { createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { createHotMemoryMiddleware } from "./hot-memory-middleware.js";

function userMsg(text: string): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "user", timestamp: 1 };
}

function createMockMemory(results: readonly MemoryResult[] = []): MemoryComponent {
  return {
    recall: async () => results,
    store: async () => {},
  };
}

function createMemoryResult(content: string): MemoryResult {
  return {
    content,
    score: 1.0,
  };
}

describe("createHotMemoryMiddleware", () => {
  const ctx = createMockTurnContext();

  test("has name 'koi:hot-memory'", () => {
    const mw = createHotMemoryMiddleware({
      memory: createMockMemory(),
    });
    expect(mw.name).toBe("koi:hot-memory");
  });

  test("has priority 310", () => {
    const mw = createHotMemoryMiddleware({
      memory: createMockMemory(),
    });
    expect(mw.priority).toBe(310);
  });

  test("injects hot memories into model call", async () => {
    const memories = [createMemoryResult("Remember: ESM only"), createMemoryResult("No mutation")];
    const mw = createHotMemoryMiddleware({
      memory: createMockMemory(memories),
    });

    const messages = [userMsg("hello")];
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

    const passedMessages = spy.calls[0]?.messages;
    expect(passedMessages).toBeDefined();
    // Hot memory message should be prepended
    expect(passedMessages?.[0]?.senderId).toBe("system:hot-memory");
    expect(passedMessages?.[0]?.content[0]?.kind).toBe("text");
    // Original messages preserved
    expect(passedMessages?.[1]?.senderId).toBe("user");
  });

  test("injects hot memories into model stream", async () => {
    const memories = [createMemoryResult("Hot fact")];
    const mw = createHotMemoryMiddleware({
      memory: createMockMemory(memories),
    });

    const messages = [userMsg("hello")];
    let capturedMessages: readonly InboundMessage[] | undefined;
    const handler = async function* (req: { readonly messages: readonly InboundMessage[] }) {
      capturedMessages = req.messages;
      yield { kind: "done" as const, response: { content: "ok", model: "test" } };
    };

    if (mw.wrapModelStream !== undefined) {
      for await (const _chunk of mw.wrapModelStream(ctx, { messages }, handler)) {
        /* drain */
      }
    }

    expect(capturedMessages?.[0]?.senderId).toBe("system:hot-memory");
    expect(capturedMessages?.[1]?.senderId).toBe("user");
  });

  test("no injection when recall returns empty", async () => {
    const mw = createHotMemoryMiddleware({
      memory: createMockMemory([]),
    });

    const messages = [userMsg("hello")];
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

    // Should pass through unmodified
    expect(spy.calls[0]?.messages).toEqual(messages);
  });

  test("graceful degradation on recall error", async () => {
    const failingMemory: MemoryComponent = {
      recall: async () => {
        throw new Error("recall failed");
      },
      store: async () => {},
    };

    const mw = createHotMemoryMiddleware({
      memory: failingMemory,
    });

    const messages = [userMsg("hello")];
    const spy = createSpyModelHandler();
    // Should not throw
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
    // Should pass through unmodified (no cache after error)
    expect(spy.calls[0]?.messages).toEqual(messages);
  });

  test("respects maxTokens budget", async () => {
    // Create a memory that would exceed the budget
    const longContent = "x".repeat(1000); // ~250 tokens
    const memories = [createMemoryResult(longContent)];
    const mw = createHotMemoryMiddleware({
      memory: createMockMemory(memories),
      maxTokens: 50, // 50 tokens = ~200 chars
    });

    const messages = [userMsg("hello")];
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

    const hotMsg = spy.calls[0]?.messages?.[0];
    expect(hotMsg?.senderId).toBe("system:hot-memory");
    if (hotMsg?.content[0]?.kind === "text") {
      // Should be truncated — length limited to ~200 chars + header
      expect(hotMsg.content[0].text).toContain("...[truncated]");
      expect(hotMsg.content[0].text.length).toBeLessThan(1000);
    }
  });

  test("refreshes at correct interval", async () => {
    let recallCount = 0;
    const memory: MemoryComponent = {
      recall: async () => {
        recallCount++;
        return [createMemoryResult("fact")];
      },
      store: async () => {},
    };

    const mw = createHotMemoryMiddleware({
      memory,
      refreshInterval: 3,
    });

    const messages = [userMsg("hello")];
    const spy = createSpyModelHandler();

    // Turn 0: initial fetch (recallCount = 1) + refresh at turn 0 (but turn++ happens after)
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
    expect(recallCount).toBe(1); // Initial fetch only

    // Turns 1-2: no refresh
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

    // Wait for any fire-and-forget refreshes
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Turn 3 triggers refresh (turnCount=3, 3 % 3 === 0)
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have 1 (initial) + 1 (turn 3 refresh) = at least 2
    expect(recallCount).toBeGreaterThanOrEqual(2);
  });

  test("describeCapabilities reports count and budget", async () => {
    const memories = [createMemoryResult("fact A"), createMemoryResult("fact B")];
    const mw = createHotMemoryMiddleware({
      memory: createMockMemory(memories),
      maxTokens: 4000,
    });

    // Trigger initial fetch
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [userMsg("hello")] }, spy.handler);

    const fragment = mw.describeCapabilities?.(ctx);
    expect(fragment).toBeDefined();
    expect(fragment?.label).toBe("hot-memory");
    expect(fragment?.description).toContain("2 hot memories");
    expect(fragment?.description).toContain("/4000 tokens");
  });

  test("describeCapabilities returns undefined when no hot memories", async () => {
    const mw = createHotMemoryMiddleware({
      memory: createMockMemory([]),
    });

    // Trigger initial fetch
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [userMsg("hello")] }, spy.handler);

    const fragment = mw.describeCapabilities?.(ctx);
    expect(fragment).toBeUndefined();
  });

  test("refreshInterval 0 means session start only", async () => {
    let recallCount = 0;
    const memory: MemoryComponent = {
      recall: async () => {
        recallCount++;
        return [createMemoryResult("fact")];
      },
      store: async () => {},
    };

    const mw = createHotMemoryMiddleware({
      memory,
      refreshInterval: 0,
    });

    const messages = [userMsg("hello")];
    const spy = createSpyModelHandler();

    // Multiple turns — only initial fetch should happen
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);
    await mw.wrapModelCall?.(ctx, { messages }, spy.handler);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recallCount).toBe(1);
  });
});
