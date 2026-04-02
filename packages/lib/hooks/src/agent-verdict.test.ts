import { describe, expect, it } from "bun:test";
import { parseVerdictOutput, verdictToDecision } from "./agent-verdict.js";

// ---------------------------------------------------------------------------
// parseVerdictOutput
// ---------------------------------------------------------------------------

describe("parseVerdictOutput", () => {
  it("parses valid ok=true verdict", () => {
    const result = parseVerdictOutput(JSON.stringify({ ok: true }));
    expect(result).toEqual({ ok: true, reason: undefined });
  });

  it("parses valid ok=false verdict with reason", () => {
    const result = parseVerdictOutput(JSON.stringify({ ok: false, reason: "unsafe code" }));
    expect(result).toEqual({ ok: false, reason: "unsafe code" });
  });

  it("parses ok=false without reason", () => {
    const result = parseVerdictOutput(JSON.stringify({ ok: false }));
    expect(result).toEqual({ ok: false, reason: undefined });
  });

  it("returns undefined for empty string", () => {
    expect(parseVerdictOutput("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(parseVerdictOutput("   ")).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseVerdictOutput("not json")).toBeUndefined();
  });

  it("returns undefined for array", () => {
    expect(parseVerdictOutput("[1,2,3]")).toBeUndefined();
  });

  it("returns undefined for string JSON", () => {
    expect(parseVerdictOutput('"hello"')).toBeUndefined();
  });

  it("returns undefined when ok is not boolean", () => {
    expect(parseVerdictOutput(JSON.stringify({ ok: "yes" }))).toBeUndefined();
  });

  it("returns undefined when ok is missing", () => {
    expect(parseVerdictOutput(JSON.stringify({ reason: "test" }))).toBeUndefined();
  });

  it("ignores non-string reason", () => {
    const result = parseVerdictOutput(JSON.stringify({ ok: false, reason: 123 }));
    expect(result).toEqual({ ok: false, reason: undefined });
  });

  it("handles extra fields gracefully", () => {
    const result = parseVerdictOutput(JSON.stringify({ ok: true, reason: "good", extra: "data" }));
    expect(result).toEqual({ ok: true, reason: "good" });
  });

  it("trims whitespace before parsing", () => {
    const result = parseVerdictOutput(`  ${JSON.stringify({ ok: true })}  `);
    expect(result).toEqual({ ok: true, reason: undefined });
  });
});

// ---------------------------------------------------------------------------
// verdictToDecision
// ---------------------------------------------------------------------------

describe("verdictToDecision", () => {
  it("maps ok=true to continue decision", () => {
    expect(verdictToDecision({ ok: true, reason: undefined })).toEqual({ kind: "continue" });
  });

  it("maps ok=false to block decision with reason", () => {
    expect(verdictToDecision({ ok: false, reason: "unsafe" })).toEqual({
      kind: "block",
      reason: "unsafe",
    });
  });

  it("maps ok=false without reason to default message", () => {
    const decision = verdictToDecision({ ok: false, reason: undefined });
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") {
      expect(decision.reason).toContain("verification failed");
    }
  });

  it("ignores reason when ok=true", () => {
    expect(verdictToDecision({ ok: true, reason: "all good" })).toEqual({ kind: "continue" });
  });
});
