import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionTranscript, TranscriptLoadResult } from "@koi/core";
import { createAgentSummary } from "../factory.js";
import type { ModelRequest, SessionId } from "../types.js";

const SID = "sess" as SessionId;

function loadFixture(name: string): TranscriptLoadResult {
  const raw = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
  return JSON.parse(raw) as TranscriptLoadResult;
}

function mkTranscript(lr: TranscriptLoadResult): SessionTranscript {
  return {
    load: () => ({ ok: true, value: lr }),
    loadPage: () => ({
      ok: true,
      value: { entries: [], total: 0, hasMore: false },
    }),
    compact: () => ({ ok: true, value: { preserved: 0 } }),
  } as unknown as SessionTranscript;
}

const cannedFor = (mode: string): string =>
  JSON.stringify({
    goal: `goal for ${mode}`,
    status: "succeeded",
    actions: [],
    outcomes: ["ok"],
    errors: [],
    learnings: [],
  });

describe("integration — fixtures", () => {
  test("(a) clean-12turn: all three granularities return kind: clean and pass metadata to modelCall", async () => {
    const fx = loadFixture("clean-12turn.json");
    for (const g of ["high", "medium", "detailed"] as const) {
      let seenMode: string | undefined;
      const summary = createAgentSummary({
        transcript: mkTranscript(fx),
        modelCall: async (req: ModelRequest) => {
          seenMode = req.metadata.summaryMode;
          return { text: cannedFor(g) };
        },
      });
      const r = await summary.summarizeSession(SID, { granularity: g });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.kind).toBe("clean");
      expect(seenMode).toBe(g);
    }
  });

  test("(a) summarizeSession is cache-hit on second identical call", async () => {
    const fx = loadFixture("clean-12turn.json");
    let calls = 0;
    const summary = createAgentSummary({
      transcript: mkTranscript(fx),
      modelCall: async () => {
        calls++;
        return { text: cannedFor("medium") };
      },
    });
    const r1 = await summary.summarizeSession(SID);
    const r2 = await summary.summarizeSession(SID);
    expect(r1.ok && r2.ok).toBe(true);
    expect(calls).toBe(1);
  });

  test("(b) crash-artifact + range toTurn < lastTurn → degraded", async () => {
    const fx = loadFixture("crash-artifact.json");
    const summary = createAgentSummary({
      transcript: mkTranscript(fx),
      modelCall: async () => ({ text: cannedFor("medium") }),
    });
    const r = await summary.summarizeRange(SID, 0, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe("degraded");
  });

  test("(b) crash-artifact + range toTurn >= lastTurn → range-tail-crash", async () => {
    const fx = loadFixture("crash-artifact.json");
    const summary = createAgentSummary({
      transcript: mkTranscript(fx),
      modelCall: async () => ({ text: cannedFor("medium") }),
    });
    const r = await summary.summarizeRange(SID, 0, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.reason).toBe("range-tail-crash");
  });

  test("(c) parse-error via range → range-strict", async () => {
    const fx = loadFixture("parse-error-midfile.json");
    const summary = createAgentSummary({
      transcript: mkTranscript(fx),
      modelCall: async () => ({ text: cannedFor("medium") }),
    });
    const r = await summary.summarizeRange(SID, 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.reason).toBe("range-strict");
  });

  test("(c) parse-error via summarizeSession with any strategy → session-parse-error", async () => {
    const fx = loadFixture("parse-error-midfile.json");
    const summary = createAgentSummary({
      transcript: mkTranscript(fx),
      modelCall: async () => ({ text: cannedFor("medium") }),
    });
    for (const strat of ["reject", "drop_last_turn", "include_all"] as const) {
      const r = await summary.summarizeSession(SID, {
        crashTailStrategy: strat,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.context?.reason).toBe("session-parse-error");
    }
  });

  test("(d) compacted: range → range-compacted; session+allowCompacted → kind: compacted", async () => {
    const fx = loadFixture("compacted.json");
    const summary = createAgentSummary({
      transcript: mkTranscript(fx),
      modelCall: async () => ({ text: cannedFor("medium") }),
    });
    const rRange = await summary.summarizeRange(SID, 0, 0);
    expect(rRange.ok).toBe(false);
    if (!rRange.ok) expect(rRange.error.context?.reason).toBe("range-compacted");
    const rNoOpt = await summary.summarizeSession(SID);
    expect(rNoOpt.ok).toBe(false);
    if (!rNoOpt.ok) expect(rNoOpt.error.context?.reason).toBe("session-compacted");
    const rOpt = await summary.summarizeSession(SID, { allowCompacted: true });
    expect(rOpt.ok).toBe(true);
    if (rOpt.ok && rOpt.value.kind === "compacted") {
      expect(rOpt.value.derived.meta.hasCompactionPrefix).toBe(true);
      expect(rOpt.value.derived.meta.rangeOrigin).toBe("post-compaction");
    }
  });
});
