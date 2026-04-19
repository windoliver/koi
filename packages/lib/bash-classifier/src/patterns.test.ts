import { describe, expect, test } from "bun:test";
import { DANGEROUS_PATTERNS } from "./patterns.js";

describe("DANGEROUS_PATTERNS", () => {
  test("is non-empty and frozen", () => {
    expect(DANGEROUS_PATTERNS.length).toBeGreaterThan(0);
    // readonly array — mutation attempts must throw under `"use strict"`
    expect(() => {
      (DANGEROUS_PATTERNS as unknown as { push(x: unknown): void }).push({});
    }).toThrow();
  });

  test("every pattern has required fields", () => {
    for (const p of DANGEROUS_PATTERNS) {
      expect(typeof p.id).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(typeof p.message).toBe("string");
      expect(["low", "medium", "high", "critical"]).toContain(p.severity);
      expect([
        "process-spawn",
        "file-destructive",
        "network-exfil",
        "code-exec",
        "module-load",
        "privilege-escalation",
      ]).toContain(p.category);
    }
  });

  test("pattern ids are unique", () => {
    const ids = DANGEROUS_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no pattern uses stateful regex flags (g / y)", () => {
    for (const p of DANGEROUS_PATTERNS) {
      expect(p.regex.flags).not.toContain("g");
      expect(p.regex.flags).not.toContain("y");
    }
  });

  test("covers the six required categories", () => {
    const cats = new Set(DANGEROUS_PATTERNS.map((p) => p.category));
    expect(cats.has("process-spawn")).toBe(true);
    expect(cats.has("file-destructive")).toBe(true);
    expect(cats.has("network-exfil")).toBe(true);
    expect(cats.has("code-exec")).toBe(true);
    expect(cats.has("module-load")).toBe(true);
    expect(cats.has("privilege-escalation")).toBe(true);
  });
});
