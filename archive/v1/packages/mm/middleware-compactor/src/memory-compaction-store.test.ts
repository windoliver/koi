import { describe, expect, test } from "bun:test";
import type { CompactionResult } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";
import { createMemoryCompactionStore } from "./memory-compaction-store.js";

function summaryMsg(text: string): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "system:compactor", timestamp: 1 };
}

function makeResult(summary: string): CompactionResult {
  return {
    messages: [summaryMsg(summary)],
    originalTokens: 100,
    compactedTokens: 20,
    strategy: "llm-summary",
  };
}

describe("createMemoryCompactionStore", () => {
  test("load returns undefined for unknown session", async () => {
    const store = createMemoryCompactionStore();
    const result = await store.load("unknown-session");
    expect(result).toBeUndefined();
  });

  test("save then load returns the stored result", async () => {
    const store = createMemoryCompactionStore();
    const result = makeResult("summary-1");
    await store.save("session-1", result);
    const loaded = await store.load("session-1");
    expect(loaded).toEqual(result);
  });

  test("overwrite replaces the previous result", async () => {
    const store = createMemoryCompactionStore();
    const first = makeResult("first");
    const second = makeResult("second");
    await store.save("session-1", first);
    await store.save("session-1", second);
    const loaded = await store.load("session-1");
    expect(loaded).toEqual(second);
  });

  test("stores results independently per session", async () => {
    const store = createMemoryCompactionStore();
    const r1 = makeResult("s1");
    const r2 = makeResult("s2");
    await store.save("a", r1);
    await store.save("b", r2);
    expect(await store.load("a")).toEqual(r1);
    expect(await store.load("b")).toEqual(r2);
  });
});
