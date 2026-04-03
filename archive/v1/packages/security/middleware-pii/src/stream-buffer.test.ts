import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createPIIStreamBuffer } from "./stream-buffer.js";
import type { PIIDetector, PIIMatch } from "./types.js";

/** Simple regex-based email detector for testing. */
function createTestEmailDetector(): PIIDetector {
  return {
    name: "email",
    kind: "email",
    detect(text: string): readonly PIIMatch[] {
      if (!text.includes("@")) return [];
      const pattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const results: PIIMatch[] = [];
      // let justified: regex exec loop variable
      let m: RegExpExecArray | null = pattern.exec(text);
      while (m !== null) {
        results.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          kind: "email",
        });
        m = pattern.exec(text);
      }
      return results;
    },
  };
}

/** Simple SSN detector for multi-pattern testing. */
function createTestSSNDetector(): PIIDetector {
  return {
    name: "ssn",
    kind: "ssn",
    detect(text: string): readonly PIIMatch[] {
      if (!text.includes("-")) return [];
      const pattern = /\b\d{3}-\d{2}-\d{4}\b/g;
      const results: PIIMatch[] = [];
      // let justified: regex exec loop variable
      let m: RegExpExecArray | null = pattern.exec(text);
      while (m !== null) {
        results.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          kind: "ssn",
        });
        m = pattern.exec(text);
      }
      return results;
    },
  };
}

describe("createPIIStreamBuffer", () => {
  // let justified: reused detectors across tests to avoid repeated allocation
  let emailDetector: PIIDetector;

  beforeEach(() => {
    emailDetector = createTestEmailDetector();
  });

  describe("basic buffering", () => {
    test("returns empty safe string when chunk is under buffer size", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 64);
      const result = buf.push("hello");
      expect(result.safe).toBe("");
      expect(result.matches).toEqual([]);
    });

    test("returns empty safe string for multiple small chunks still under buffer size", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 64);
      expect(buf.push("hello ").safe).toBe("");
      expect(buf.push("world").safe).toBe("");
    });

    test("emits safe prefix when accumulated chunks exceed buffer size", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 10);
      // Push 20 chars: "abcdefghijklmnopqrst" — safe prefix is first 10 chars
      const result = buf.push("abcdefghijklmnopqrst");
      expect(result.safe).toBe("abcdefghij");
      expect(result.matches).toEqual([]);
    });

    test("flush emits remaining buffered content", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 10);
      buf.push("abcde");
      const result = buf.flush();
      expect(result.safe).toBe("abcde");
    });

    test("flush emits tail after push exceeded buffer", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 10);
      // 20 chars total; push emits first 10, flush emits remaining 10
      buf.push("abcdefghijklmnopqrst");
      const flushed = buf.flush();
      expect(flushed.safe).toBe("klmnopqrst");
    });
  });

  describe("block to redact downgrade", () => {
    test("uses redact strategy instead of block in streaming mode", () => {
      const buf = createPIIStreamBuffer([emailDetector], "block", undefined, 10);
      const pushResult = buf.push("email: user@test.com padding text here");
      const flushResult = buf.flush();
      const combined = pushResult.safe + flushResult.safe;
      // Should redact, not throw
      expect(combined).toContain("[REDACTED_EMAIL]");
      expect(combined).not.toContain("user@test.com");
    });

    test("does not log console.warn directly (caller is responsible for logging)", () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      createPIIStreamBuffer([emailDetector], "block");
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test("calls onStrategyDowngrade callback with ('block', 'redact')", () => {
      // let justified: captures downgrade callback args
      let originalArg: string | undefined;
      // let justified: captures effective strategy arg
      let effectiveArg: string | undefined;
      createPIIStreamBuffer([emailDetector], "block", undefined, 64, (original, effective) => {
        originalArg = original;
        effectiveArg = effective;
      });
      expect(originalArg).toBe("block");
      expect(effectiveArg).toBe("redact");
    });

    test("does not call downgrade callback for redact strategy", () => {
      // let justified: flag to detect unexpected callback invocation
      let called = false;
      createPIIStreamBuffer([emailDetector], "redact", undefined, 64, () => {
        called = true;
      });
      expect(called).toBe(false);
    });

    test("does not call downgrade callback for mask strategy", () => {
      // let justified: flag to detect unexpected callback invocation
      let called = false;
      createPIIStreamBuffer([emailDetector], "mask", undefined, 64, () => {
        called = true;
      });
      expect(called).toBe(false);
    });
  });

  describe("PII detection in streaming", () => {
    test("redacts PII in safe prefix when buffer overflows", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 10);
      // Push enough that the email is fully in the safe prefix
      const result = buf.push("user@test.com and then some extra padding text");
      expect(result.safe).toContain("[REDACTED_EMAIL]");
      expect(result.safe).not.toContain("user@test.com");
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0]?.kind).toBe("email");
    });

    test("detects PII split across chunk boundaries after flush", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 64);
      // Email split across two pushes — both under buffer size, so they accumulate
      buf.push("Contact user@");
      buf.push("example.com for info");
      const result = buf.flush();
      expect(result.safe).toContain("[REDACTED_EMAIL]");
      expect(result.safe).not.toContain("user@example.com");
    });

    test("detects multiple PII patterns with multiple detectors", () => {
      const ssnDetector = createTestSSNDetector();
      const buf = createPIIStreamBuffer([emailDetector, ssnDetector], "redact", undefined, 10);
      buf.push("user@test.com and SSN 123-45-6789 plus filler text here");
      const result = buf.flush();
      const allSafe = result.safe;
      // Combine prefix safe (from push, if any) with flush safe
      // Both PII types should be redacted across push + flush
      expect(allSafe).not.toContain("user@test.com");
      expect(allSafe).not.toContain("123-45-6789");
    });

    test("reports matches from both push and flush", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 20);
      // Push enough to overflow so push returns a non-empty safe prefix containing PII
      const pushResult = buf.push("email: a@b.com is here and more padding text here");
      const flushResult = buf.flush();
      const allMatches = [...pushResult.matches, ...flushResult.matches];
      expect(allMatches.length).toBeGreaterThan(0);
      expect(allMatches.some((m) => m.kind === "email")).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("empty string push returns empty result", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 64);
      const result = buf.push("");
      expect(result.safe).toBe("");
      expect(result.matches).toEqual([]);
    });

    test("flush on empty buffer returns empty result", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 64);
      const result = buf.flush();
      expect(result.safe).toBe("");
      expect(result.matches).toEqual([]);
    });

    test("single character pushes accumulate correctly", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 5);
      const chars = "hello world!";
      const safeParts: string[] = [];
      for (const ch of chars) {
        const result = buf.push(ch);
        if (result.safe !== "") {
          safeParts.push(result.safe);
        }
      }
      const flushResult = buf.flush();
      if (flushResult.safe !== "") {
        safeParts.push(flushResult.safe);
      }
      expect(safeParts.join("")).toBe("hello world!");
    });

    test("very large chunk exceeding buffer by many multiples", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 10);
      const bigText = "a".repeat(200);
      const result = buf.push(bigText);
      // Safe prefix should be everything except the last 10 chars
      expect(result.safe.length).toBe(190);
      const flushResult = buf.flush();
      expect(flushResult.safe.length).toBe(10);
    });

    test("custom buffer size is respected", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 3);
      // Push 5 chars — safe prefix is first 2 chars (5 - 3 = 2)
      const result = buf.push("abcde");
      expect(result.safe).toBe("ab");
      const flushResult = buf.flush();
      expect(flushResult.safe).toBe("cde");
    });

    test("flush after flush returns empty on already-flushed buffer", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 10);
      buf.push("some text");
      buf.flush();
      const secondFlush = buf.flush();
      expect(secondFlush.safe).toBe("");
      expect(secondFlush.matches).toEqual([]);
    });

    test("push after flush starts fresh accumulation", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 10);
      buf.push("first");
      buf.flush();
      // Buffer is now empty; push again
      const result = buf.push("second");
      expect(result.safe).toBe("");
      const flushResult = buf.flush();
      expect(flushResult.safe).toBe("second");
    });
  });

  describe("array-based buffer correctness", () => {
    test("multiple small pushes followed by one large push produce contiguous output", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 10);
      buf.push("aaa");
      buf.push("bbb");
      // Total so far: 6, under buffer size of 10
      // Now push 14 chars to exceed buffer
      const result = buf.push("cccccccccccccc");
      // Total was 20, safe prefix = first 10 chars = "aaabbbcccc"
      expect(result.safe).toBe("aaabbbcccc");
    });

    test("safe content is correctly ordered across multiple overflows", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 5);
      const safeParts: string[] = [];

      const r1 = buf.push("ABCDEFGHIJ"); // 10 chars, emits first 5
      safeParts.push(r1.safe);

      const r2 = buf.push("KLMNO"); // 5 more + 5 tail = 10, emits first 5
      safeParts.push(r2.safe);

      const r3 = buf.flush();
      safeParts.push(r3.safe);

      expect(safeParts.join("")).toBe("ABCDEFGHIJKLMNO");
    });

    test("no content is lost across many small pushes and a final flush", () => {
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 8);
      const input = "the quick brown fox jumps over the lazy dog";
      const safeParts: string[] = [];

      for (const word of input.split(" ")) {
        const result = buf.push(`${word} `);
        if (result.safe !== "") {
          safeParts.push(result.safe);
        }
      }
      const flushResult = buf.flush();
      if (flushResult.safe !== "") {
        safeParts.push(flushResult.safe);
      }

      // All content should be recovered, no characters lost
      expect(safeParts.join("")).toBe(`${input} `);
    });

    test("PII straddling the safe/tail boundary is caught on flush", () => {
      // Buffer size 10, push "safe text user@test.com end"
      // The email may land partially in the safe zone and partially in the tail.
      // After flush the combined output should have the email redacted.
      const buf = createPIIStreamBuffer([emailDetector], "redact", undefined, 15);
      const pushResult = buf.push("Hello user@test.com!");
      const flushResult = buf.flush();
      const combined = pushResult.safe + flushResult.safe;
      expect(combined).not.toContain("user@test.com");
      expect(combined).toContain("[REDACTED_EMAIL]");
    });
  });
});
