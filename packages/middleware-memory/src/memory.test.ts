import { describe, expect, mock, test } from "bun:test";
import type { InboundMessage, ModelRequest } from "@koi/core";
import { createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { createMemoryMiddleware } from "./memory.js";
import type { MemoryStore } from "./store.js";
import { createInMemoryStore } from "./store.js";

describe("createMemoryMiddleware", () => {
  const makeMessage = (text: string): InboundMessage => ({
    senderId: "user-1",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  });

  test("has name 'memory'", () => {
    const mw = createMemoryMiddleware({ store: createInMemoryStore() });
    expect(mw.name).toBe("memory");
  });

  test("has priority 400", () => {
    const mw = createMemoryMiddleware({ store: createInMemoryStore() });
    expect(mw.priority).toBe(400);
  });

  test("wrapModelCall enriches messages with recalled memories", async () => {
    const store = createInMemoryStore();
    await store.store("s1", "The user likes blue");
    const mw = createMemoryMiddleware({ store });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = { messages: [makeMessage("What color?")] };
    await mw.wrapModelCall?.(ctx, request, spy.handler);

    // Spy should receive enriched request with memory context prepended
    expect(spy.calls).toHaveLength(1);
    const enrichedReq = spy.calls[0];
    expect(enrichedReq).toBeDefined();
    expect(enrichedReq?.messages.length).toBe(2); // memory + original
    const firstMsg = enrichedReq?.messages[0];
    if (firstMsg && firstMsg.content[0]?.kind === "text") {
      expect(firstMsg.content[0].text).toContain("[Memory Context]");
      expect(firstMsg.content[0].text).toContain("The user likes blue");
    }
  });

  test("next() called with enriched request", async () => {
    const store = createInMemoryStore();
    await store.store("s1", "some memory");
    const mw = createMemoryMiddleware({ store });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [makeMessage("test")] }, spy.handler);
    expect(spy.calls).toHaveLength(1);
    // Enriched request should have more messages than original
    expect(spy.calls[0]?.messages.length).toBeGreaterThan(1);
  });

  test("response stored after call when storeResponses is true", async () => {
    const store = createInMemoryStore();
    const mw = createMemoryMiddleware({ store, storeResponses: true });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler({ content: "The answer is 42" });
    await mw.wrapModelCall?.(ctx, { messages: [makeMessage("question")] }, spy.handler);

    // The response content should be stored
    const recalled = await store.recall("test", 4000);
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.content).toBe("The answer is 42");
  });

  test("response not stored when storeResponses is false", async () => {
    const store = createInMemoryStore();
    const mw = createMemoryMiddleware({ store, storeResponses: false });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler({ content: "secret" });
    await mw.wrapModelCall?.(ctx, { messages: [makeMessage("test")] }, spy.handler);

    const recalled = await store.recall("test", 4000);
    expect(recalled).toHaveLength(0);
  });

  test("empty recall passes through unchanged", async () => {
    const store = createInMemoryStore();
    const mw = createMemoryMiddleware({ store });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const originalMessages = [makeMessage("hello")];
    const request: ModelRequest = { messages: originalMessages };
    await mw.wrapModelCall?.(ctx, request, spy.handler);

    // With empty recall, the original request should be passed through
    expect(spy.calls[0]?.messages).toHaveLength(1);
    expect(spy.calls[0]).toBe(request);
  });

  test("store failure does not crash middleware", async () => {
    const failingStore: MemoryStore = {
      recall: async () => [],
      store: async () => {
        throw new Error("store broken");
      },
    };
    const mw = createMemoryMiddleware({ store: failingStore });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler({ content: "response" });
    const response = await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    // Should still return the response
    expect(response?.content).toBe("response");
  });

  test("returns response from next()", async () => {
    const mw = createMemoryMiddleware({ store: createInMemoryStore() });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler({ content: "hello world" });
    const response = await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    expect(response?.content).toBe("hello world");
  });

  test("does not define wrapToolCall", () => {
    const mw = createMemoryMiddleware({ store: createInMemoryStore() });
    expect(mw.wrapToolCall).toBeUndefined();
  });

  test("uses maxRecallTokens parameter", async () => {
    const store = createInMemoryStore();
    // Store many entries
    for (let i = 0; i < 20; i++) {
      await store.store("s1", `Memory entry number ${i} with some content padding`);
    }
    const mw = createMemoryMiddleware({ store, maxRecallTokens: 50 });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [makeMessage("test")] }, spy.handler);

    // With limited tokens, shouldn't include all 20 entries
    const enrichedReq = spy.calls[0];
    expect(enrichedReq).toBeDefined();
    // Memory message + original = 2, but memory content should be limited
    expect(enrichedReq?.messages.length).toBe(2);
  });

  test("multiple recall entries joined with separator", async () => {
    const store = createInMemoryStore();
    await store.store("s1", "Memory A");
    await store.store("s1", "Memory B");
    const mw = createMemoryMiddleware({ store });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [makeMessage("test")] }, spy.handler);

    const memMsg = spy.calls[0]?.messages[0];
    expect(memMsg).toBeDefined();
    if (memMsg && memMsg.content[0]?.kind === "text") {
      expect(memMsg.content[0].text).toContain("Memory A");
      expect(memMsg.content[0].text).toContain("Memory B");
      expect(memMsg.content[0].text).toContain("---");
    }
  });

  test("memory message has senderId 'system:memory'", async () => {
    const store = createInMemoryStore();
    await store.store("s1", "Some memory");
    const mw = createMemoryMiddleware({ store });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [makeMessage("test")] }, spy.handler);

    const memMsg = spy.calls[0]?.messages[0];
    expect(memMsg).toBeDefined();
    expect(memMsg?.senderId).toBe("system:memory");
  });

  test("onStoreError callback fires on store failure", async () => {
    const storeError = new Error("store broken");
    const failingStore: MemoryStore = {
      recall: async () => [],
      store: async () => {
        throw storeError;
      },
    };
    const onStoreError = mock(() => {});
    const mw = createMemoryMiddleware({ store: failingStore, onStoreError });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler({ content: "response" });
    const response = await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    expect(response?.content).toBe("response");
    expect(onStoreError).toHaveBeenCalledTimes(1);
    expect(onStoreError).toHaveBeenCalledWith(storeError);
  });

  test("store failure without onStoreError does not crash", async () => {
    const failingStore: MemoryStore = {
      recall: async () => [],
      store: async () => {
        throw new Error("store broken");
      },
    };
    const mw = createMemoryMiddleware({ store: failingStore });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler({ content: "response" });
    const response = await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    expect(response?.content).toBe("response");
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const mw = createMemoryMiddleware({ store: createInMemoryStore() });
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns label 'memory' and description containing 'memory'", () => {
      const mw = createMemoryMiddleware({ store: createInMemoryStore() });
      const ctx = createMockTurnContext();
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("memory");
      expect(result?.description).toContain("memory");
    });
  });
});
