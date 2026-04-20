import { describe, expect, test } from "bun:test";
import type { MatchEntry } from "@koi/core";
import { createBashOutputBuffer } from "./output-buffer.js";

function mkEntry(
  event: string,
  stream: "stdout" | "stderr",
  overrides: Partial<MatchEntry> = {},
): MatchEntry {
  return {
    event,
    stream,
    lineNumber: overrides.lineNumber ?? 1,
    timestamp: overrides.timestamp ?? 0,
    line: overrides.line ?? "x",
    lineByteLength: overrides.lineByteLength ?? 1,
    lineClippedPrefixBytes: overrides.lineClippedPrefixBytes ?? 0,
    lineClippedSuffixBytes: overrides.lineClippedSuffixBytes ?? 0,
    lineOriginalByteLength: overrides.lineOriginalByteLength ?? 1,
    matchSpanUnits: overrides.matchSpanUnits ?? { start: 0, end: 1 },
  };
}

describe("BashOutputBuffer — main stream", () => {
  test("accepts stdout + stderr writes; snapshot returns both", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    b.write("stdout", "hello ");
    b.write("stderr", "warn ");
    b.write("stdout", "world\n");
    const snap = b.snapshot();
    expect(snap.stdout).toContain("hello");
    expect(snap.stdout).toContain("world");
    expect(snap.stderr).toContain("warn");
    expect(snap.truncated).toBe(false);
  });

  test("evicts oldest bytes past cap; marks truncated", () => {
    const b = createBashOutputBuffer({ maxBytes: 100 });
    b.write("stdout", "A".repeat(200));
    const snap = b.snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.stdout.length).toBeLessThanOrEqual(100);
  });

  test("cap applies per stream (each stream has its own cap)", () => {
    const b = createBashOutputBuffer({ maxBytes: 50 });
    b.write("stdout", "A".repeat(60));
    b.write("stderr", "B".repeat(60));
    const snap = b.snapshot();
    expect(snap.stdout.length).toBeLessThanOrEqual(50);
    expect(snap.stderr.length).toBeLessThanOrEqual(50);
    expect(snap.truncated).toBe(true);
  });
});

describe("BashOutputBuffer — matches side-buffer", () => {
  test("recordMatch + queryMatches returns entries", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    b.recordMatch(
      mkEntry("ready", "stdout", {
        line: "server ready",
        lineByteLength: 12,
        matchSpanUnits: { start: 7, end: 12 },
      }),
    );
    const r = b.queryMatches({});
    expect(r.kind).toBe("matches");
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.event).toBe("ready");
    expect(r.truncated).toBe(false);
    expect(r.dropped_before_cursor).toBe(0);
  });

  test("evicts past 64 entries; surfaces truncated + dropped count", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    for (let i = 0; i < 80; i++) {
      b.recordMatch(mkEntry("x", "stdout", { lineNumber: i }));
    }
    const r = b.queryMatches({});
    expect(r.entries).toHaveLength(64);
    expect(r.dropped_before_cursor).toBe(16);
    expect(r.truncated).toBe(true);
  });

  test("event filter narrows to matching event only", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    b.recordMatch(mkEntry("ready", "stdout"));
    b.recordMatch(mkEntry("err", "stderr"));
    b.recordMatch(mkEntry("ready", "stdout"));
    const r = b.queryMatches({ event: "ready" });
    expect(r.entries).toHaveLength(2);
    expect(r.entries.every((e) => e.event === "ready")).toBe(true);
  });

  test("stream filter narrows to matching stream only", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    b.recordMatch(mkEntry("e", "stdout"));
    b.recordMatch(mkEntry("e", "stderr"));
    const r = b.queryMatches({ stream: "stderr" });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.stream).toBe("stderr");
  });

  test("combined event + stream filter", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    b.recordMatch(mkEntry("ready", "stdout"));
    b.recordMatch(mkEntry("ready", "stderr"));
    b.recordMatch(mkEntry("err", "stdout"));
    const r = b.queryMatches({ event: "ready", stream: "stdout" });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.event).toBe("ready");
    expect(r.entries[0]?.stream).toBe("stdout");
  });

  test("cursor pagination within same filter returns only new entries", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    b.recordMatch(mkEntry("ready", "stdout", { lineNumber: 1 }));
    b.recordMatch(mkEntry("ready", "stdout", { lineNumber: 2 }));
    const first = b.queryMatches({ event: "ready", stream: "stdout" });
    expect(first.entries).toHaveLength(2);
    b.recordMatch(mkEntry("ready", "stdout", { lineNumber: 3 }));
    const second = b.queryMatches({ event: "ready", stream: "stdout", offset: first.cursor });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.lineNumber).toBe(3);
  });

  test("cursor from one filter is rejected when passed to a different filter", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    b.recordMatch(mkEntry("ready", "stdout"));
    const first = b.queryMatches({ event: "ready", stream: "stdout" });
    expect(() => b.queryMatches({ event: "err", stream: "stdout", offset: first.cursor })).toThrow(
      /cursor filter mismatch/i,
    );
  });

  test("empty buffer returns empty entries and zero dropped", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    const r = b.queryMatches({});
    expect(r.entries).toHaveLength(0);
    expect(r.dropped_before_cursor).toBe(0);
    expect(r.truncated).toBe(false);
  });

  test("malformed cursor sequence throws cursor validation error", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    b.recordMatch(mkEntry("ready", "stdout"));
    // Cursor has matching event/stream but non-numeric sequence — sequence check fires.
    expect(() =>
      b.queryMatches({ event: "ready", stream: "stdout", offset: "s=abc&e=ready&r=stdout" }),
    ).toThrow(/cursor sequence/i);
  });

  test("negative cursor sequence rejected", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    // Cursor includes matching filter components so sequence check fires (not filter mismatch).
    expect(() =>
      b.queryMatches({ event: "ready", stream: "stdout", offset: "s=-1&e=ready&r=stdout" }),
    ).toThrow();
  });

  test("cursor missing sequence component throws", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    // Cursor has matching event/stream but no s= — missing sequence check fires.
    expect(() =>
      b.queryMatches({ event: "ready", stream: "stdout", offset: "e=ready&r=stdout" }),
    ).toThrow(/missing sequence/i);
  });

  test("float string cursor sequence rejected (parseInt partial accept)", () => {
    const b = createBashOutputBuffer({ maxBytes: 1_000 });
    b.recordMatch(mkEntry("ready", "stdout"));
    // parseInt("5.5") returns 5 but String(5) !== "5.5" — must reject
    expect(() => b.queryMatches({ offset: "s=5.5" })).toThrow(/cursor sequence/i);
  });
});
