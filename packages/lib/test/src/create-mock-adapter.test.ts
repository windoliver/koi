import { describe, expect, test } from "bun:test";
import type { ModelChunk, ModelRequest } from "@koi/core";
import { createMockAdapter, streamTextChunks, textResponse } from "./create-mock-adapter.js";

const emptyRequest: ModelRequest = { messages: [] };

describe("createMockAdapter — complete", () => {
  test("returns scripted response and records the call", async () => {
    const { adapter, calls, callCount } = createMockAdapter({
      calls: [{ mode: "complete", response: textResponse("hello") }],
    });

    const result = await adapter.complete(emptyRequest);
    expect(result.content).toBe("hello");
    expect(callCount()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mode).toBe("complete");
  });

  test("throws when script is exhausted", async () => {
    const { adapter } = createMockAdapter({
      calls: [{ mode: "complete", response: textResponse("first") }],
    });
    await adapter.complete(emptyRequest);
    await expect(adapter.complete(emptyRequest)).rejects.toThrow(/exhausted/);
  });

  test("throws on mode mismatch (complete called, stream expected)", async () => {
    const { adapter } = createMockAdapter({
      calls: [{ mode: "stream", chunks: streamTextChunks("x") }],
    });
    await expect(adapter.complete(emptyRequest)).rejects.toThrow(/expected stream/);
  });
});

describe("createMockAdapter — stream", () => {
  test("yields scripted chunks", async () => {
    const { adapter } = createMockAdapter({
      calls: [{ mode: "stream", chunks: streamTextChunks("hi") }],
    });

    const collected: ModelChunk[] = [];
    for await (const chunk of adapter.stream(emptyRequest)) {
      collected.push(chunk);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual({ kind: "text_delta", delta: "hi" });
    expect(collected[1]?.kind).toBe("done");
  });

  test("does NOT advance call index when stream is never iterated", async () => {
    const { adapter, callCount } = createMockAdapter({
      calls: [
        { mode: "stream", chunks: streamTextChunks("first") },
        { mode: "stream", chunks: streamTextChunks("second") },
      ],
    });

    // Create the iterable but do not pull from it
    adapter.stream(emptyRequest);
    expect(callCount()).toBe(0);

    // The next stream should still get the first scripted response
    const collected: ModelChunk[] = [];
    for await (const chunk of adapter.stream(emptyRequest)) {
      collected.push(chunk);
    }
    expect(collected[0]).toEqual({ kind: "text_delta", delta: "first" });
    expect(callCount()).toBe(1);
  });

  test("throws on exhaustion", async () => {
    const { adapter } = createMockAdapter({
      calls: [{ mode: "stream", chunks: streamTextChunks("only") }],
    });
    // drain first
    for await (const _ of adapter.stream(emptyRequest)) {
      // consume
    }
    // second stream pull should throw
    await expect(
      (async (): Promise<void> => {
        for await (const _ of adapter.stream(emptyRequest)) {
          // consume
        }
      })(),
    ).rejects.toThrow(/exhausted/);
  });
});

describe("createMockAdapter — onExhausted repeat-last", () => {
  test("replays the final complete call", async () => {
    const { adapter } = createMockAdapter({
      calls: [{ mode: "complete", response: textResponse("loop") }],
      onExhausted: "repeat-last",
    });
    const a = await adapter.complete(emptyRequest);
    const b = await adapter.complete(emptyRequest);
    const c = await adapter.complete(emptyRequest);
    expect(a.content).toBe("loop");
    expect(b.content).toBe("loop");
    expect(c.content).toBe("loop");
  });

  test("throws on repeat-last if mode mismatches", async () => {
    const { adapter } = createMockAdapter({
      calls: [{ mode: "complete", response: textResponse("loop") }],
      onExhausted: "repeat-last",
    });
    await adapter.complete(emptyRequest);
    await expect(
      (async (): Promise<void> => {
        for await (const _ of adapter.stream(emptyRequest)) {
          // consume
        }
      })(),
    ).rejects.toThrow(/repeat-last/);
  });
});

describe("createMockAdapter — reset", () => {
  test("reset clears call index and recorded calls", async () => {
    const { adapter, callCount, calls, reset } = createMockAdapter({
      calls: [
        { mode: "complete", response: textResponse("one") },
        { mode: "complete", response: textResponse("two") },
      ],
    });
    await adapter.complete(emptyRequest);
    expect(callCount()).toBe(1);
    expect(calls).toHaveLength(1);

    reset();
    expect(callCount()).toBe(0);
    expect(calls).toHaveLength(0);

    const again = await adapter.complete(emptyRequest);
    expect(again.content).toBe("one");
  });
});

describe("createMockAdapter — capabilities & metadata", () => {
  test("default id and provider", () => {
    const { adapter } = createMockAdapter({ calls: [] });
    expect(adapter.id).toBe("mock-adapter");
    expect(adapter.provider).toBe("mock");
  });

  test("override id, provider, capabilities", () => {
    const { adapter } = createMockAdapter({
      calls: [],
      id: "custom",
      provider: "fake-provider",
      capabilities: { vision: true },
    });
    expect(adapter.id).toBe("custom");
    expect(adapter.provider).toBe("fake-provider");
    expect(adapter.capabilities.vision).toBe(true);
    // Unspecified capability falls back to default
    expect(adapter.capabilities.streaming).toBe(true);
  });
});
