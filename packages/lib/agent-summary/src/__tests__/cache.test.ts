import { describe, expect, test } from "bun:test";
import { type CacheKeyInput, cacheKey, createMemoryCache } from "../cache.js";
import type { SessionId, SkippedTranscriptEntry, SummaryOk } from "../types.js";

const base: CacheKeyInput = {
  sessionId: "s1" as SessionId,
  fromTurn: 0,
  toTurn: 2,
  entries: [],
  granularity: "medium",
  focus: {
    goals: true,
    tool_calls: true,
    errors: true,
    files_changed: true,
    decisions: true,
  },
  maxTokens: 1200,
  modelHint: "cheap",
  schemaVersion: 1,
  promptVersion: 1,
  degraded: false,
  skipped: [],
  hasCompactionPrefix: false,
  compactionEntryCount: 0,
  droppedTailTurns: 0,
};

const skip = (
  lineNumber: number,
  reason: SkippedTranscriptEntry["reason"],
  raw = "r",
  error = "e",
): SkippedTranscriptEntry => ({ lineNumber, raw, error, reason });

describe("cacheKey identity fields", () => {
  test("deterministic across two calls with same input", () => {
    expect(cacheKey(base)).toBe(cacheKey(base));
  });

  test("sessionId changes key", () => {
    expect(cacheKey({ ...base, sessionId: "s2" as SessionId })).not.toBe(cacheKey(base));
  });

  test("fromTurn changes key", () => {
    expect(cacheKey({ ...base, fromTurn: 1 })).not.toBe(cacheKey(base));
  });

  test("toTurn changes key", () => {
    expect(cacheKey({ ...base, toTurn: 3 })).not.toBe(cacheKey(base));
  });

  test("granularity changes key", () => {
    expect(cacheKey({ ...base, granularity: "high" })).not.toBe(cacheKey(base));
  });

  test("focus changes key", () => {
    expect(cacheKey({ ...base, focus: { ...base.focus, tool_calls: false } })).not.toBe(
      cacheKey(base),
    );
  });

  test("maxTokens changes key", () => {
    expect(cacheKey({ ...base, maxTokens: 300 })).not.toBe(cacheKey(base));
  });

  test("modelHint changes key", () => {
    expect(cacheKey({ ...base, modelHint: "smart" })).not.toBe(cacheKey(base));
  });

  test("promptVersion changes key", () => {
    expect(cacheKey({ ...base, promptVersion: 2 })).not.toBe(cacheKey(base));
  });

  test("degraded=true with any skipped changes key", () => {
    expect(
      cacheKey({
        ...base,
        degraded: true,
        skipped: [skip(10, "crash_artifact")],
      }),
    ).not.toBe(cacheKey(base));
  });

  test("hasCompactionPrefix changes key", () => {
    expect(cacheKey({ ...base, hasCompactionPrefix: true })).not.toBe(cacheKey(base));
  });

  test("compactionEntryCount changes key", () => {
    expect(cacheKey({ ...base, compactionEntryCount: 1 })).not.toBe(cacheKey(base));
  });

  test("droppedTailTurns changes key", () => {
    expect(cacheKey({ ...base, droppedTailTurns: 1 })).not.toBe(cacheKey(base));
  });
});

describe("cacheKey skipped fingerprint", () => {
  test("different raw produces distinct key", () => {
    const a: CacheKeyInput = {
      ...base,
      degraded: true,
      skipped: [skip(10, "crash_artifact", "raw-a", "e")],
    };
    const b: CacheKeyInput = {
      ...base,
      degraded: true,
      skipped: [skip(10, "crash_artifact", "raw-b", "e")],
    };
    expect(cacheKey(a)).not.toBe(cacheKey(b));
  });

  test("different error produces distinct key", () => {
    const a: CacheKeyInput = {
      ...base,
      degraded: true,
      skipped: [skip(10, "crash_artifact", "r", "err-a")],
    };
    const b: CacheKeyInput = {
      ...base,
      degraded: true,
      skipped: [skip(10, "crash_artifact", "r", "err-b")],
    };
    expect(cacheKey(a)).not.toBe(cacheKey(b));
  });

  test("different reason produces distinct key", () => {
    const a: CacheKeyInput = {
      ...base,
      degraded: true,
      skipped: [skip(10, "crash_artifact")],
    };
    const b: CacheKeyInput = {
      ...base,
      degraded: true,
      skipped: [skip(10, "parse_error")],
    };
    expect(cacheKey(a)).not.toBe(cacheKey(b));
  });

  test("order-independent — sorted by lineNumber", () => {
    const a: CacheKeyInput = {
      ...base,
      degraded: true,
      skipped: [skip(10, "crash_artifact"), skip(20, "crash_artifact")],
    };
    const b: CacheKeyInput = {
      ...base,
      degraded: true,
      skipped: [skip(20, "crash_artifact"), skip(10, "crash_artifact")],
    };
    expect(cacheKey(a)).toBe(cacheKey(b));
  });
});

describe("createMemoryCache", () => {
  test("miss → set → hit", async () => {
    const cache = createMemoryCache();
    const key = "k1";
    expect(await cache.get(key)).toBeUndefined();
    const env: SummaryOk = {
      kind: "clean",
      summary: {
        sessionId: "s" as SessionId,
        range: { fromTurn: 0, toTurn: 0, entryCount: 0 },
        goal: "",
        status: "succeeded",
        actions: [],
        outcomes: [],
        errors: [],
        learnings: [],
        meta: {
          granularity: "medium",
          modelHint: "cheap",
          hash: "k1",
          generatedAt: 0,
          schemaVersion: 1,
          hasCompactionPrefix: false,
          rangeOrigin: "raw",
        },
      },
    };
    await cache.set(key, env);
    expect(await cache.get(key)).toBe(env);
  });
});
