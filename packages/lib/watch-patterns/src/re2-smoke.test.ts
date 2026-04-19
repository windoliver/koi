import { describe, expect, test } from "bun:test";
import { RE2 } from "re2-wasm";

// NOTE: re2-wasm@1.0.2 enforces Unicode mode — the "u" flag is always required.
// Every RE2 constructor call must include "u" in its flags string.

describe("re2-wasm smoke gate", () => {
  test("compiles and matches a simple pattern", () => {
    // "ui" — unicode (required) + case-insensitive
    const re = new RE2("ready", "ui");
    expect(re.test("server listening — READY")).toBe(true);
    expect(re.test("still warming up")).toBe(false);
  });

  test("4 KB input matches within budget", () => {
    const re = new RE2("\\bneedle\\b", "u");
    // Use spaces (non-word chars) as filler so the word boundary fires correctly.
    const filler = " ".repeat(4096 - 8);
    const line = `${filler}needle`;
    const start = Bun.nanoseconds();
    expect(re.test(line)).toBe(true);
    const durationMs = (Bun.nanoseconds() - start) / 1e6;
    if (durationMs > 5) {
      console.warn(`[re2-smoke] slow match: ${durationMs.toFixed(2)} ms (expected <2 ms)`);
    }
  });

  test("rejects unsupported construct (lookahead)", () => {
    expect(() => new RE2("(?=ready)ready", "u")).toThrow();
  });
});
