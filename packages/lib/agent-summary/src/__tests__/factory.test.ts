import { describe, expect, test } from "bun:test";
import type {
  SessionId,
  SessionTranscript,
  SkippedTranscriptEntry,
  TranscriptEntry,
  TranscriptLoadResult,
} from "@koi/core";
import { transcriptEntryId } from "@koi/core";
import { createAgentSummary } from "../factory.js";
import type { ModelRequest, ModelResponse, SummaryCache, SummaryEvent } from "../types.js";

const SID = "sess-1" as SessionId;

function mockTranscript(result: TranscriptLoadResult): SessionTranscript {
  return {
    load: () => ({ ok: true, value: result }),
    loadPage: () => ({
      ok: true,
      value: { entries: [], total: 0, hasMore: false },
    }),
    compact: () => ({ ok: true, value: { preserved: 0 } }),
  } as unknown as SessionTranscript;
}

const e = (id: string, role: TranscriptEntry["role"], c = ""): TranscriptEntry => ({
  id: transcriptEntryId(id),
  role,
  content: c,
  timestamp: 0,
});
const skip = (
  lineNumber: number,
  reason: SkippedTranscriptEntry["reason"],
): SkippedTranscriptEntry => ({ lineNumber, raw: "r", error: "er", reason });

const goodJson = JSON.stringify({
  goal: "do the thing",
  status: "succeeded",
  actions: [],
  outcomes: ["done"],
  errors: [],
  learnings: [],
});
const canned =
  (text = goodJson) =>
  async (_req: ModelRequest): Promise<ModelResponse> => ({ text });

describe("factory — happy paths", () => {
  test("summarizeSession clean → kind: clean", async () => {
    const entries = [e("u1", "user"), e("a1", "assistant")];
    const events: SummaryEvent[] = [];
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: canned(),
      clock: () => 123,
      onEvent: (ev) => events.push(ev),
    });
    const r = await summary.summarizeSession(SID);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === "clean") {
      expect(r.value.summary.sessionId).toBe(SID);
      expect(r.value.summary.goal).toBe("do the thing");
      expect(r.value.summary.meta.rangeOrigin).toBe("raw");
      expect(r.value.summary.meta.hasCompactionPrefix).toBe(false);
    } else {
      throw new Error("expected kind: clean");
    }
    expect(events.some((x) => x.kind === "cache.miss")).toBe(true);
    expect(events.some((x) => x.kind === "model.start")).toBe(true);
    expect(events.some((x) => x.kind === "model.end")).toBe(true);
  });

  test("summarizeRange clean → kind: clean", async () => {
    const entries = [e("u1", "user"), e("a1", "assistant"), e("u2", "user"), e("a2", "assistant")];
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: canned(),
    });
    const r = await summary.summarizeRange(SID, 0, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe("clean");
  });

  test("cache hit on second identical call", async () => {
    const entries = [e("u1", "user")];
    let calls = 0;
    const events: SummaryEvent[] = [];
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: async () => {
        calls++;
        return { text: goodJson };
      },
      onEvent: (ev) => events.push(ev),
    });
    await summary.summarizeSession(SID);
    await summary.summarizeSession(SID);
    expect(calls).toBe(1);
    expect(events.filter((x) => x.kind === "cache.hit").length).toBe(1);
  });

  test("distinct sessionIds don't share cache", async () => {
    const entries = [e("u1", "user")];
    let calls = 0;
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: async () => {
        calls++;
        return { text: goodJson };
      },
    });
    await summary.summarizeSession(SID);
    await summary.summarizeSession("sess-other" as SessionId);
    expect(calls).toBe(2);
  });
});

describe("factory — range integrity", () => {
  test("compacted transcript → RANGE (VALIDATION) range-compacted", async () => {
    const entries = [e("c1", "compaction"), e("u1", "user")];
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: canned(),
    });
    const r = await summary.summarizeRange(SID, 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.reason).toBe("range-compacted");
  });

  test("parse_error skip → range-strict", async () => {
    const entries = [e("u1", "user"), e("a1", "assistant")];
    const summary = createAgentSummary({
      transcript: mockTranscript({
        entries,
        skipped: [skip(3, "parse_error")],
      }),
      modelCall: canned(),
    });
    const r = await summary.summarizeRange(SID, 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.reason).toBe("range-strict");
  });

  test("crash_artifact + toTurn < lastTurn → kind: degraded", async () => {
    const entries = [e("u1", "user"), e("a1", "assistant"), e("u2", "user"), e("a2", "assistant")];
    const summary = createAgentSummary({
      transcript: mockTranscript({
        entries,
        skipped: [skip(99, "crash_artifact")],
      }),
      modelCall: canned(),
    });
    const r = await summary.summarizeRange(SID, 0, 0);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === "degraded") {
      expect(r.value.skipped.length).toBe(1);
      expect(r.value.droppedTailTurns).toBe(0);
    } else {
      throw new Error("expected kind: degraded");
    }
  });

  test("crash_artifact + toTurn >= lastTurn → range-tail-crash", async () => {
    const entries = [e("u1", "user"), e("a1", "assistant"), e("u2", "user")];
    const summary = createAgentSummary({
      transcript: mockTranscript({
        entries,
        skipped: [skip(99, "crash_artifact")],
      }),
      modelCall: canned(),
    });
    const r = await summary.summarizeRange(SID, 0, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.context?.reason).toBe("range-tail-crash");
      expect(r.error.context?.lastSafeToTurn).toBe(0);
    }
  });

  test("crash_artifact + ≤1 turn → range-crash-no-prefix", async () => {
    const entries = [e("u1", "user")];
    const summary = createAgentSummary({
      transcript: mockTranscript({
        entries,
        skipped: [skip(99, "crash_artifact")],
      }),
      modelCall: canned(),
    });
    const r = await summary.summarizeRange(SID, 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.reason).toBe("range-crash-no-prefix");
  });
});

describe("factory — session integrity", () => {
  test("truly empty → session-empty", async () => {
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries: [], skipped: [] }),
      modelCall: canned(),
    });
    const r = await summary.summarizeSession(SID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.reason).toBe("session-empty");
  });

  test("all-skipped transcript → session-all-skipped", async () => {
    const summary = createAgentSummary({
      transcript: mockTranscript({
        entries: [],
        skipped: [skip(1, "parse_error")],
      }),
      modelCall: canned(),
    });
    const r = await summary.summarizeSession(SID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.reason).toBe("session-all-skipped");
  });

  test("compacted + no opt-in → session-compacted", async () => {
    const entries = [e("c1", "compaction"), e("u1", "user")];
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: canned(),
    });
    const r = await summary.summarizeSession(SID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.reason).toBe("session-compacted");
  });

  test("compacted + allowCompacted: true → kind: compacted", async () => {
    const entries = [e("c1", "compaction"), e("u1", "user"), e("a1", "assistant")];
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: canned(),
    });
    const r = await summary.summarizeSession(SID, { allowCompacted: true });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === "compacted") {
      expect(r.value.compactionEntryCount).toBe(1);
      expect(r.value.derived.meta.rangeOrigin).toBe("post-compaction");
      expect(r.value.derived.meta.hasCompactionPrefix).toBe(true);
    } else {
      throw new Error("expected kind: compacted");
    }
  });

  test("parse_error skip + any strategy → session-parse-error", async () => {
    const entries = [e("u1", "user"), e("a1", "assistant")];
    for (const strat of ["reject", "drop_last_turn", "include_all"] as const) {
      const summary = createAgentSummary({
        transcript: mockTranscript({
          entries,
          skipped: [skip(2, "parse_error")],
        }),
        modelCall: canned(),
      });
      const r = await summary.summarizeSession(SID, {
        crashTailStrategy: strat,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.context?.reason).toBe("session-parse-error");
    }
  });

  test("crash_artifact + reject (default) → session-strict", async () => {
    const entries = [e("u1", "user"), e("a1", "assistant"), e("u2", "user")];
    const summary = createAgentSummary({
      transcript: mockTranscript({
        entries,
        skipped: [skip(99, "crash_artifact")],
      }),
      modelCall: canned(),
    });
    const r = await summary.summarizeSession(SID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.reason).toBe("session-strict");
  });

  test("crash_artifact + drop_last_turn → kind: degraded + droppedTailTurns: 1", async () => {
    const entries = [e("u1", "user"), e("a1", "assistant"), e("u2", "user"), e("a2", "assistant")];
    const summary = createAgentSummary({
      transcript: mockTranscript({
        entries,
        skipped: [skip(99, "crash_artifact")],
      }),
      modelCall: canned(),
    });
    const r = await summary.summarizeSession(SID, {
      crashTailStrategy: "drop_last_turn",
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === "degraded") {
      expect(r.value.droppedTailTurns).toBe(1);
      expect(r.value.partial.range.toTurn).toBe(0);
    } else {
      throw new Error("expected kind: degraded");
    }
  });

  test("crash_artifact + drop_last_turn + ≤1 turn → session-crash-only-turn", async () => {
    const entries = [e("u1", "user"), e("a1", "assistant")];
    const summary = createAgentSummary({
      transcript: mockTranscript({
        entries,
        skipped: [skip(99, "crash_artifact")],
      }),
      modelCall: canned(),
    });
    const r = await summary.summarizeSession(SID, {
      crashTailStrategy: "drop_last_turn",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.reason).toBe("session-crash-only-turn");
  });

  test("crash_artifact + include_all → kind: degraded + droppedTailTurns: 0", async () => {
    const entries = [e("u1", "user"), e("a1", "assistant"), e("u2", "user")];
    const summary = createAgentSummary({
      transcript: mockTranscript({
        entries,
        skipped: [skip(99, "crash_artifact")],
      }),
      modelCall: canned(),
    });
    const r = await summary.summarizeSession(SID, {
      crashTailStrategy: "include_all",
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === "degraded") {
      expect(r.value.droppedTailTurns).toBe(0);
    } else {
      throw new Error("expected kind: degraded");
    }
  });
});

describe("factory — parse retry + cache fault paths", () => {
  const entries = [e("u1", "user")];
  const mkCache = (hooks: {
    get?: (k: string) => unknown;
    set?: (k: string, v: unknown) => void;
  }): SummaryCache =>
    ({
      get: (k: string) => hooks.get?.(k),
      set: (k: string, v: unknown) => {
        hooks.set?.(k, v);
      },
    }) as unknown as SummaryCache;

  test("parse fails first then succeeds on retry", async () => {
    let call = 0;
    const events: SummaryEvent[] = [];
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: async () => {
        call++;
        return { text: call === 1 ? "not json" : goodJson };
      },
      onEvent: (ev) => events.push(ev),
    });
    const r = await summary.summarizeSession(SID);
    expect(r.ok).toBe(true);
    expect(events.some((x) => x.kind === "parse.retry")).toBe(true);
    expect(call).toBe(2);
  });

  test("parse fails twice → EXTERNAL with parse.fail event", async () => {
    const events: SummaryEvent[] = [];
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: async () => ({ text: "still not json" }),
      onEvent: (ev) => events.push(ev),
    });
    const r = await summary.summarizeSession(SID);
    expect(r.ok).toBe(false);
    expect(events.some((x) => x.kind === "parse.fail")).toBe(true);
  });

  test("modelCall rejection → EXTERNAL MODEL error (retryable)", async () => {
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: async () => {
        throw new Error("network down");
      },
    });
    const r = await summary.summarizeSession(SID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.retryable).toBe(true);
  });

  test("cache.get rejection emits cache.read_fail and recomputes", async () => {
    const events: SummaryEvent[] = [];
    let calls = 0;
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: async () => {
        calls++;
        return { text: goodJson };
      },
      cache: mkCache({
        get: () => {
          throw new Error("boom");
        },
        set: () => {},
      }),
      onEvent: (ev) => events.push(ev),
    });
    const r = await summary.summarizeSession(SID);
    expect(r.ok).toBe(true);
    expect(events.some((x) => x.kind === "cache.read_fail")).toBe(true);
    expect(calls).toBe(1);
  });

  test("cache.set rejection emits cache.write_fail; Result.ok preserved", async () => {
    const events: SummaryEvent[] = [];
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: async () => ({ text: goodJson }),
      cache: mkCache({
        get: () => undefined,
        set: () => {
          throw new Error("disk full");
        },
      }),
      onEvent: (ev) => events.push(ev),
    });
    const r = await summary.summarizeSession(SID);
    expect(r.ok).toBe(true);
    expect(events.some((x) => x.kind === "cache.write_fail")).toBe(true);
  });

  test("poisoned cache value → cache.corrupt + recompute", async () => {
    const events: SummaryEvent[] = [];
    let calls = 0;
    const summary = createAgentSummary({
      transcript: mockTranscript({ entries, skipped: [] }),
      modelCall: async () => {
        calls++;
        return { text: goodJson };
      },
      cache: mkCache({
        get: () => ({
          kind: "clean",
          summary: {
            sessionId: "WRONG",
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
              hash: "zzz",
              generatedAt: 0,
              schemaVersion: 1,
              hasCompactionPrefix: false,
              rangeOrigin: "raw",
            },
          },
        }),
        set: () => {},
      }),
      onEvent: (ev) => events.push(ev),
    });
    const r = await summary.summarizeSession(SID);
    expect(r.ok).toBe(true);
    expect(events.some((x) => x.kind === "cache.corrupt")).toBe(true);
    expect(calls).toBe(1);
  });
});
