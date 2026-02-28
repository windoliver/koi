/**
 * Tests for createGoalExtractorSource — LLM-based goal extraction with caching.
 */

import { describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { TurnContext } from "@koi/core/middleware";
import { createMockSessionContext, createMockTurnContext } from "@koi/test-utils";
import { createGoalExtractorSource } from "./goal-extractor.js";

function makeMessages(...texts: readonly string[]): readonly InboundMessage[] {
  return texts.map((text) => ({
    senderId: "user",
    timestamp: Date.now(),
    content: [{ kind: "text" as const, text }],
  }));
}

function makeTurnCtx(messages: readonly InboundMessage[], sid: string = "session-1") {
  return createMockTurnContext({
    session: createMockSessionContext({ sessionId: sessionId(sid) }),
    messages: [...messages],
  });
}

/** Extract the fetch function from the extractor source (always kind: "dynamic"). */
function getFetch(
  extractor: ReturnType<typeof createGoalExtractorSource>,
): (ctx: TurnContext) => string | Promise<string> {
  const { source } = extractor;
  if (source.kind !== "dynamic") throw new Error("expected dynamic source");
  return source.fetch;
}

describe("createGoalExtractorSource", () => {
  test("calls summarize on first injection and returns result", async () => {
    let callCount = 0;
    const extractor = createGoalExtractorSource({
      summarize: async (msgs) => {
        callCount++;
        const first = msgs[0]?.content[0];
        return first?.kind === "text" ? `Goal: ${first.text}` : "unknown";
      },
    });
    const fetch = getFetch(extractor);

    const ctx = makeTurnCtx(makeMessages("Refactor auth module"));
    const result = await fetch(ctx);

    expect(result).toBe("Goal: Refactor auth module");
    expect(callCount).toBe(1);
  });

  test("caches result and skips LLM on subsequent calls (extractEvery=3)", async () => {
    let callCount = 0;
    const fetch = getFetch(
      createGoalExtractorSource({
        summarize: async () => {
          callCount++;
          return `goal-v${String(callCount)}`;
        },
        extractEvery: 3,
      }),
    );

    const ctx = makeTurnCtx(makeMessages("do something"));

    // Call 1: extracts (injectionCount 0 % 3 === 0)
    const r1 = await fetch(ctx);
    expect(r1).toBe("goal-v1");
    expect(callCount).toBe(1);

    // Call 2: cached (injectionCount 1 % 3 !== 0)
    const r2 = await fetch(ctx);
    expect(r2).toBe("goal-v1");
    expect(callCount).toBe(1);

    // Call 3: cached (injectionCount 2 % 3 !== 0)
    const r3 = await fetch(ctx);
    expect(r3).toBe("goal-v1");
    expect(callCount).toBe(1);

    // Call 4: re-extracts (injectionCount 3 % 3 === 0)
    const r4 = await fetch(ctx);
    expect(r4).toBe("goal-v2");
    expect(callCount).toBe(2);
  });

  test("defaults extractEvery to 1 — extracts on every injection", async () => {
    let callCount = 0;
    const fetch = getFetch(
      createGoalExtractorSource({
        summarize: async () => {
          callCount++;
          return `goal-${String(callCount)}`;
        },
      }),
    );

    const ctx = makeTurnCtx(makeMessages("task"));

    await fetch(ctx);
    await fetch(ctx);
    await fetch(ctx);

    expect(callCount).toBe(3);
  });

  test("isolates cache per session", async () => {
    let callCount = 0;
    const fetch = getFetch(
      createGoalExtractorSource({
        summarize: async (msgs) => {
          callCount++;
          const first = msgs[0]?.content[0];
          return first?.kind === "text" ? first.text : "unknown";
        },
        extractEvery: 2,
      }),
    );

    const ctx1 = makeTurnCtx(makeMessages("goal A"), "s1");
    const ctx2 = makeTurnCtx(makeMessages("goal B"), "s2");

    const r1 = await fetch(ctx1);
    const r2 = await fetch(ctx2);

    expect(r1).toBe("goal A");
    expect(r2).toBe("goal B");
    expect(callCount).toBe(2);

    // Second call on s1: cached
    const r1b = await fetch(ctx1);
    expect(r1b).toBe("goal A");
    expect(callCount).toBe(2);
  });

  test("fail-safe: returns cached goal when summarize throws", async () => {
    let shouldThrow = false;
    const fetch = getFetch(
      createGoalExtractorSource({
        summarize: async () => {
          if (shouldThrow) throw new Error("LLM down");
          return "extracted goal";
        },
      }),
    );

    const ctx = makeTurnCtx(makeMessages("task"));

    // First call succeeds
    const r1 = await fetch(ctx);
    expect(r1).toBe("extracted goal");

    // Second call throws — returns cached
    shouldThrow = true;
    const r2 = await fetch(ctx);
    expect(r2).toBe("extracted goal");
  });

  test("fail-safe: returns placeholder when no cache and summarize throws", async () => {
    const fetch = getFetch(
      createGoalExtractorSource({
        summarize: async () => {
          throw new Error("LLM down");
        },
      }),
    );

    const ctx = makeTurnCtx(makeMessages("task"));
    const result = await fetch(ctx);

    expect(result).toBe("[goal extraction unavailable]");
  });

  test("clearSession removes cached goal", async () => {
    let callCount = 0;
    const extractor = createGoalExtractorSource({
      summarize: async () => {
        callCount++;
        return `goal-${String(callCount)}`;
      },
      extractEvery: 100, // very high — would normally cache for a long time
    });
    const fetch = getFetch(extractor);

    const ctx = makeTurnCtx(makeMessages("task"), "s1");

    await fetch(ctx);
    expect(callCount).toBe(1);

    // Without clear: would return cached
    // With clear: forces re-extraction
    extractor.clearSession("s1");

    await fetch(ctx);
    expect(callCount).toBe(2);
  });

  test("goal updates when conversation changes on re-extraction", async () => {
    const fetch = getFetch(
      createGoalExtractorSource({
        summarize: async (msgs) => {
          const last = msgs[msgs.length - 1]?.content[0];
          return last?.kind === "text" ? last.text : "unknown";
        },
        extractEvery: 2,
      }),
    );

    // First extraction with original messages
    const ctx1 = makeTurnCtx(makeMessages("refactor auth"), "s1");
    const r1 = await fetch(ctx1);
    expect(r1).toBe("refactor auth");

    // Cached (injectionCount 1 % 2 !== 0)
    const r2 = await fetch(ctx1);
    expect(r2).toBe("refactor auth");

    // Re-extraction with new messages (injectionCount 2 % 2 === 0)
    const ctx2 = makeTurnCtx(makeMessages("refactor auth", "fix payment bug"), "s1");
    const r3 = await fetch(ctx2);
    expect(r3).toBe("fix payment bug");
  });

  test("source kind is always dynamic", () => {
    const { source } = createGoalExtractorSource({
      summarize: async () => "goal",
    });
    expect(source.kind).toBe("dynamic");
  });
});
