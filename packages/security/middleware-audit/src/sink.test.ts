import { describe, expect, test } from "bun:test";
import type { AuditEntry } from "./sink.js";
import { applyRedaction, createInMemoryAuditSink, truncate } from "./sink.js";

describe("InMemoryAuditSink", () => {
  const makeEntry = (kind: AuditEntry["kind"] = "model_call"): AuditEntry => ({
    timestamp: Date.now(),
    sessionId: "s1",
    agentId: "a1",
    turnIndex: 0,
    kind,
    durationMs: 100,
  });

  test("stores entries", async () => {
    const sink = createInMemoryAuditSink();
    await sink.log(makeEntry());
    expect(sink.entries).toHaveLength(1);
  });

  test("stores multiple entries", async () => {
    const sink = createInMemoryAuditSink();
    await sink.log(makeEntry("model_call"));
    await sink.log(makeEntry("tool_call"));
    await sink.log(makeEntry("session_start"));
    expect(sink.entries).toHaveLength(3);
  });

  test("entries are accessible in order", async () => {
    const sink = createInMemoryAuditSink();
    await sink.log(makeEntry("session_start"));
    await sink.log(makeEntry("model_call"));
    await sink.log(makeEntry("session_end"));
    expect(sink.entries[0]?.kind).toBe("session_start");
    expect(sink.entries[1]?.kind).toBe("model_call");
    expect(sink.entries[2]?.kind).toBe("session_end");
  });

  test("flush is a no-op", async () => {
    const sink = createInMemoryAuditSink();
    await sink.log(makeEntry());
    await sink.flush?.();
    expect(sink.entries).toHaveLength(1);
  });
});

describe("applyRedaction", () => {
  test("replaces matching patterns", () => {
    const result = applyRedaction("my secret key is abc123", [
      { pattern: /secret key is \w+/g, replacement: "secret key is [REDACTED]" },
    ]);
    expect(result).toBe("my secret key is [REDACTED]");
  });

  test("applies multiple rules", () => {
    const result = applyRedaction("email: test@test.com ssn: 123-45-6789", [
      { pattern: /[\w.]+@[\w.]+/g, replacement: "[EMAIL]" },
      { pattern: /\d{3}-\d{2}-\d{4}/g, replacement: "[SSN]" },
    ]);
    expect(result).toBe("email: [EMAIL] ssn: [SSN]");
  });

  test("returns original when no rules match", () => {
    const result = applyRedaction("nothing to redact", [
      { pattern: /secret/g, replacement: "[REDACTED]" },
    ]);
    expect(result).toBe("nothing to redact");
  });

  test("handles empty rules array", () => {
    const result = applyRedaction("text", []);
    expect(result).toBe("text");
  });
});

describe("truncate", () => {
  test("returns text under max length", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  test("truncates text over max length", () => {
    const result = truncate("a".repeat(200), 50);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("[truncated]");
  });

  test("exact length is not truncated", () => {
    const text = "a".repeat(50);
    expect(truncate(text, 50)).toBe(text);
  });
});
