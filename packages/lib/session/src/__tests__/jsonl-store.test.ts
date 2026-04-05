import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@koi/core";
import { createJsonlTranscript } from "../transcript/jsonl-store.js";
import {
  makeTranscriptEntry,
  runSessionTranscriptContractTests,
} from "./contracts/transcript-contract.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "koi-test-jsonl-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Contract tests — same suite as in-memory implementation
// ---------------------------------------------------------------------------

describe("JsonlTranscript (contract)", () => {
  runSessionTranscriptContractTests(() => createJsonlTranscript({ baseDir: tmpDir }));
});

// ---------------------------------------------------------------------------
// JSONL-specific: concurrent append test (decision 10-A)
//
// Tests that the per-session async queue prevents data loss when 10 concurrent
// append() calls race for the same session.
//
// Note: O_APPEND atomicity for multi-process concurrent writes is guaranteed
// by POSIX at the kernel level. What we test here is the single-process async
// queue — ensuring our code serializes correctly within one process.
// ---------------------------------------------------------------------------

describe("JsonlTranscript (concurrency)", () => {
  test("10 concurrent appends do not lose or corrupt entries", async () => {
    const store = createJsonlTranscript({ baseDir: tmpDir });
    const sid = sessionId("concurrent-s1");

    // Fire 10 appends simultaneously — the queue must serialize them
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeTranscriptEntry({ content: `msg-${i}`, timestamp: 1000 * (i + 1) }),
    );
    await Promise.all(entries.map((e) => store.append(sid, [e])));

    const result = await store.load(sid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // All 10 entries must be present — no data lost, no JSONL corruption
      expect(result.value.entries.length).toBe(10);
      expect(result.value.skipped.length).toBe(0);

      // All original content must round-trip correctly
      const contents = new Set(result.value.entries.map((e) => e.content));
      for (let i = 0; i < 10; i++) {
        expect(contents.has(`msg-${i}`)).toBe(true);
      }
    }
  });

  test("concurrent append and compact do not lose entries", async () => {
    const store = createJsonlTranscript({ baseDir: tmpDir });
    const sid = sessionId("race-s1");

    // Seed with some entries first
    const seedEntries = Array.from({ length: 5 }, (_, i) =>
      makeTranscriptEntry({ content: `seed-${i}` }),
    );
    await store.append(sid, seedEntries);

    // Race: 5 appends + 1 compact simultaneously
    const raceAppends = Array.from({ length: 5 }, (_, i) =>
      store.append(sid, [makeTranscriptEntry({ content: `race-${i}` })]),
    );
    const raceCompact = store.compact(sid, "Summary", 3);
    await Promise.all([...raceAppends, raceCompact]);

    // After all ops settle: result must be parseable (not corrupt)
    const result = await store.load(sid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must have at least the compaction entry + preserved entries (no corruption)
      expect(result.value.entries.length).toBeGreaterThan(0);
      expect(result.value.skipped.length).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// JSONL-specific: crash artifact detection (SkippedTranscriptEntry.reason)
// ---------------------------------------------------------------------------

describe("JsonlTranscript (crash artifact detection)", () => {
  test("trailing malformed line is tagged as crash_artifact", async () => {
    const store = createJsonlTranscript({ baseDir: tmpDir });
    const sid = sessionId("crash-s1");

    // Write a valid entry first
    const validEntry = makeTranscriptEntry({ content: "valid" });
    await store.append(sid, [validEntry]);

    // Simulate a crash: append a partial JSON line (as if a write was interrupted)
    const filePath = join(tmpDir, `${String(sid)}.jsonl`);
    await Bun.write(filePath, `${await Bun.file(filePath).text()}{"id":"x","role":"user"\n`);

    const result = await store.load(sid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entries.length).toBe(1);
      expect(result.value.entries[0]?.content).toBe("valid");
      expect(result.value.skipped.length).toBe(1);
      expect(result.value.skipped[0]?.reason).toBe("crash_artifact");
    }
  });

  test("mid-file malformed line is tagged as parse_error", async () => {
    const store = createJsonlTranscript({ baseDir: tmpDir });
    const sid = sessionId("corrupt-s1");

    // Write: valid, corrupt, valid
    const e1 = makeTranscriptEntry({ content: "before" });
    const e3 = makeTranscriptEntry({ content: "after" });
    const jsonl = `${JSON.stringify(e1)}\n{not valid json}\n${JSON.stringify(e3)}\n`;

    const filePath = join(tmpDir, `${String(sid)}.jsonl`);
    await Bun.write(filePath, jsonl);

    const result = await store.load(sid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entries.length).toBe(2);
      expect(result.value.skipped.length).toBe(1);
      expect(result.value.skipped[0]?.reason).toBe("parse_error");
    }
  });
});

// ---------------------------------------------------------------------------
// JSONL-specific: path safety (encodeURIComponent filename encoding)
//
// Session IDs are URL-encoded when used as filenames, so any session ID
// format is accepted — path traversal is prevented by encoding, not rejection.
// ---------------------------------------------------------------------------

describe("JsonlTranscript (path safety)", () => {
  test("session ID with path traversal is accepted — stored safely via encoding", async () => {
    // "../evil" is encoded to "..%2Fevil.jsonl" — cannot escape baseDir
    const store = createJsonlTranscript({ baseDir: tmpDir });
    const result = await store.append(sessionId("../evil"), [makeTranscriptEntry()]);
    expect(result.ok).toBe(true);

    // Verify the file is in tmpDir, not a parent
    const { existsSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    expect(existsSync(pathJoin(tmpDir, "..%2Fevil.jsonl"))).toBe(true);
    // The original path-traversal target must NOT exist
    expect(existsSync(pathJoin(tmpDir, "..", "evil.jsonl"))).toBe(false);
  });

  test("session ID with slash is accepted — stored safely via encoding", async () => {
    const store = createJsonlTranscript({ baseDir: tmpDir });
    const result = await store.append(sessionId("a/b"), [makeTranscriptEntry()]);
    expect(result.ok).toBe(true);
  });

  test("runtime-style session ID with colons is accepted", async () => {
    // Runtime creates IDs like "agent:{agentId}:{uuid}"
    const store = createJsonlTranscript({ baseDir: tmpDir });
    const runtimeId = sessionId("agent:my-agent:550e8400-e29b-41d4-a716-446655440000");
    const result = await store.append(runtimeId, [makeTranscriptEntry({ content: "hello" })]);
    expect(result.ok).toBe(true);

    const loaded = await store.load(runtimeId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.entries.length).toBe(1);
      expect(loaded.value.entries[0]?.content).toBe("hello");
    }
  });

  test("empty session ID is rejected", async () => {
    const store = createJsonlTranscript({ baseDir: tmpDir });
    const result = await store.append(sessionId(""), [makeTranscriptEntry()]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

// ---------------------------------------------------------------------------
// Golden: @koi/session — session-transcript-compaction (decision 12-B)
//
// Standalone golden query: tests compaction integration without LLM.
// Verifies the resilience path — compact(preserveLastN=3) produces the correct
// summary + tail, and the resulting JSONL is readable and has no skipped entries.
// ---------------------------------------------------------------------------

describe("Golden: @koi/session — transcript compaction", () => {
  test("compact(preserveLastN=3) produces correct summary + tail with no corruption", async () => {
    const store = createJsonlTranscript({ baseDir: tmpDir });
    const sid = sessionId("golden-compact");

    // Append 10 entries
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeTranscriptEntry({ content: `turn-${i}`, timestamp: 1000 * (i + 1) }),
    );
    await store.append(sid, entries);

    // Compact: summarize first 7, preserve last 3
    const compactResult = await store.compact(sid, "Summary of turns 0-6", 3);
    expect(compactResult.ok).toBe(true);

    const result = await store.load(sid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // compaction entry + 3 preserved = 4 total
      expect(result.value.entries.length).toBe(4);
      expect(result.value.skipped.length).toBe(0);

      const [summary, ...tail] = result.value.entries;
      expect(summary?.role).toBe("compaction");
      expect(summary?.content).toBe("Summary of turns 0-6");
      expect(tail[0]?.content).toBe("turn-7");
      expect(tail[1]?.content).toBe("turn-8");
      expect(tail[2]?.content).toBe("turn-9");
    }
  });

  test("compact on non-existent session is a no-op success", async () => {
    const store = createJsonlTranscript({ baseDir: tmpDir });
    const result = await store.compact(sessionId("nonexistent"), "Summary", 3);
    expect(result.ok).toBe(true);
  });
});
