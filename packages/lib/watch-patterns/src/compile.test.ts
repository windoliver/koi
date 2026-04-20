import { describe, expect, test } from "bun:test";
import type { WatchPattern } from "@koi/core";
import { compilePatterns } from "./compile.js";

describe("compilePatterns", () => {
  test("compiles a simple valid pattern", () => {
    const res = compilePatterns([{ pattern: "ready", event: "ready" }]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(1);
      expect(res.value[0]?.event).toBe("ready");
    }
  });

  test("respects empty flags", () => {
    const res = compilePatterns([{ pattern: "Error", event: "err", flags: "" }]);
    expect(res.ok).toBe(true);
  });

  test("defaults flags to 'i' (case-insensitive)", () => {
    const res = compilePatterns([{ pattern: "Ready", event: "ready" }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value[0]?.re.test("READY")).toBe(true);
  });

  test("rejects pattern >256 chars", () => {
    const res = compilePatterns([{ pattern: "a".repeat(257), event: "ok" }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION");
  });

  test("rejects pattern of length 0", () => {
    const res = compilePatterns([{ pattern: "", event: "ok" }]);
    expect(res.ok).toBe(false);
  });

  test("rejects >16 patterns", () => {
    const patterns: WatchPattern[] = [];
    for (let i = 0; i < 17; i++) patterns.push({ pattern: `p${i}`, event: `e${i}` });
    const res = compilePatterns(patterns);
    expect(res.ok).toBe(false);
  });

  test.each([
    ["", "empty event"],
    ["UPPER", "uppercase"],
    ["has space", "space"],
    ['has"quote', "double quote"],
    ["has\nnewline", "newline"],
    ["has\u0000null", "null byte"],
    ["a".repeat(65), "65 chars"],
    ["__reserved", "__ prefix"],
  ])("rejects invalid event %p (%s)", (event, _why) => {
    const res = compilePatterns([{ pattern: "x", event }]);
    expect(res.ok).toBe(false);
  });

  test.each([["g"], ["y"], ["gy"]])("rejects flag %p", (flags) => {
    const res = compilePatterns([{ pattern: "x", event: "ok", flags }]);
    expect(res.ok).toBe(false);
  });

  test("rejects RE2-unsupported construct (lookahead)", () => {
    const res = compilePatterns([{ pattern: "(?=x)x", event: "ok" }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/RE2|lookahead|unsupported/i);
  });
});
