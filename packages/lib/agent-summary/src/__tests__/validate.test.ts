import { describe, expect, test } from "bun:test";
import type { SessionId, SkippedTranscriptEntry, SummaryOk } from "../types.js";
import { type ExpectedEnvelopeContext, validateCachedEnvelope } from "../validate.js";

const SID = "sess-1" as SessionId;

const skip = (
  lineNumber: number,
  reason: SkippedTranscriptEntry["reason"],
): SkippedTranscriptEntry => ({ lineNumber, raw: "r", error: "e", reason });

function mkBody(args: {
  sessionId: SessionId;
  fromTurn: number;
  toTurn: number;
  hash: string;
  hasCompactionPrefix: boolean;
  rangeOrigin: "raw" | "post-compaction";
}): SummaryOk extends { summary: infer S } ? S : never {
  return {
    sessionId: args.sessionId,
    range: { fromTurn: args.fromTurn, toTurn: args.toTurn, entryCount: 4 },
    goal: "g",
    status: "succeeded",
    actions: [],
    outcomes: [],
    errors: [],
    learnings: [],
    meta: {
      granularity: "medium",
      modelHint: "cheap",
      hash: args.hash,
      generatedAt: 0,
      schemaVersion: 1,
      hasCompactionPrefix: args.hasCompactionPrefix,
      rangeOrigin: args.rangeOrigin,
    },
  } as SummaryOk extends { summary: infer S } ? S : never;
}

const goodBody = (
  overrides: Partial<Parameters<typeof mkBody>[0]> = {},
): ReturnType<typeof mkBody> =>
  mkBody({
    sessionId: SID,
    fromTurn: 0,
    toTurn: 3,
    hash: "h1",
    hasCompactionPrefix: false,
    rangeOrigin: "raw",
    ...overrides,
  });

const baseCtx: ExpectedEnvelopeContext = {
  expectedHash: "h1",
  expectedSessionId: SID,
  expectedFromTurn: 0,
  expectedToTurn: 3,
  expectedKind: "clean",
  expectedHasCompactionPrefix: false,
  expectedRangeOrigin: "raw",
  expectedSkipped: [],
  expectedDroppedTailTurns: 0,
  expectedCompactionEntryCount: 0,
};

describe("validateCachedEnvelope — shape", () => {
  test("accepts valid clean envelope", () => {
    const env: SummaryOk = { kind: "clean", summary: goodBody() };
    const r = validateCachedEnvelope(env, baseCtx);
    expect(r.ok).toBe(true);
  });

  test("accepts valid degraded envelope", () => {
    const env: SummaryOk = {
      kind: "degraded",
      partial: goodBody(),
      skipped: [skip(10, "crash_artifact")],
      droppedTailTurns: 1,
    };
    const r = validateCachedEnvelope(env, {
      ...baseCtx,
      expectedKind: "degraded",
      expectedSkipped: [skip(10, "crash_artifact")],
      expectedDroppedTailTurns: 1,
    });
    expect(r.ok).toBe(true);
  });

  test("accepts valid compacted envelope", () => {
    const env: SummaryOk = {
      kind: "compacted",
      derived: goodBody({
        hasCompactionPrefix: true,
        rangeOrigin: "post-compaction",
      }),
      compactionEntryCount: 1,
      skipped: [],
      droppedTailTurns: 0,
    };
    const r = validateCachedEnvelope(env, {
      ...baseCtx,
      expectedKind: "compacted",
      expectedHasCompactionPrefix: true,
      expectedRangeOrigin: "post-compaction",
      expectedCompactionEntryCount: 1,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects degraded with empty skipped", () => {
    const env = {
      kind: "degraded",
      partial: goodBody(),
      skipped: [],
      droppedTailTurns: 0,
    };
    const r = validateCachedEnvelope(env, {
      ...baseCtx,
      expectedKind: "degraded",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toContain("shape");
  });
});

describe("validateCachedEnvelope — identity", () => {
  test("sessionId mismatch", () => {
    const env: SummaryOk = {
      kind: "clean",
      summary: goodBody({ sessionId: "other" as SessionId }),
    };
    const r = validateCachedEnvelope(env, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("id_mismatch");
  });

  test("range mismatch", () => {
    const env: SummaryOk = { kind: "clean", summary: goodBody({ fromTurn: 1 }) };
    const r = validateCachedEnvelope(env, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("range_mismatch");
  });

  test("hash mismatch", () => {
    const env: SummaryOk = { kind: "clean", summary: goodBody({ hash: "h2" }) };
    const r = validateCachedEnvelope(env, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("hash_mismatch");
  });

  test("kind mismatch", () => {
    const env: SummaryOk = {
      kind: "degraded",
      partial: goodBody(),
      skipped: [skip(10, "crash_artifact")],
      droppedTailTurns: 1,
    };
    const r = validateCachedEnvelope(env, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("kind_mismatch");
  });

  test("rangeOrigin flip on compacted envelope", () => {
    const env: SummaryOk = {
      kind: "compacted",
      derived: goodBody({
        hasCompactionPrefix: true,
        rangeOrigin: "raw",
      }),
      compactionEntryCount: 1,
      skipped: [],
      droppedTailTurns: 0,
    };
    const r = validateCachedEnvelope(env, {
      ...baseCtx,
      expectedKind: "compacted",
      expectedHasCompactionPrefix: true,
      expectedRangeOrigin: "post-compaction",
      expectedCompactionEntryCount: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("range_origin_mismatch");
  });
});

describe("validateCachedEnvelope — variant invariants", () => {
  test("tampered skipped.reason", () => {
    const env: SummaryOk = {
      kind: "degraded",
      partial: goodBody(),
      skipped: [skip(10, "parse_error")],
      droppedTailTurns: 1,
    };
    const r = validateCachedEnvelope(env, {
      ...baseCtx,
      expectedKind: "degraded",
      expectedSkipped: [skip(10, "crash_artifact")],
      expectedDroppedTailTurns: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("skipped_fingerprint_mismatch");
  });

  test("tampered skipped.raw", () => {
    const env: SummaryOk = {
      kind: "degraded",
      partial: goodBody(),
      skipped: [{ ...skip(10, "crash_artifact"), raw: "DIFFERENT" }],
      droppedTailTurns: 1,
    };
    const r = validateCachedEnvelope(env, {
      ...baseCtx,
      expectedKind: "degraded",
      expectedSkipped: [skip(10, "crash_artifact")],
      expectedDroppedTailTurns: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("skipped_fingerprint_mismatch");
  });

  test("droppedTailTurns mismatch", () => {
    const env: SummaryOk = {
      kind: "degraded",
      partial: goodBody(),
      skipped: [skip(10, "crash_artifact")],
      droppedTailTurns: 0,
    };
    const r = validateCachedEnvelope(env, {
      ...baseCtx,
      expectedKind: "degraded",
      expectedSkipped: [skip(10, "crash_artifact")],
      expectedDroppedTailTurns: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("dropped_turns_mismatch");
  });

  test("compactionEntryCount mismatch", () => {
    const env: SummaryOk = {
      kind: "compacted",
      derived: goodBody({
        hasCompactionPrefix: true,
        rangeOrigin: "post-compaction",
      }),
      compactionEntryCount: 2,
      skipped: [],
      droppedTailTurns: 0,
    };
    const r = validateCachedEnvelope(env, {
      ...baseCtx,
      expectedKind: "compacted",
      expectedHasCompactionPrefix: true,
      expectedRangeOrigin: "post-compaction",
      expectedCompactionEntryCount: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("compaction_count_mismatch");
  });
});
