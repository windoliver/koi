import { describe, expect, test } from "bun:test";
import { mapVerdictToDecision, parseVerdictOutput } from "./verdict.js";

describe("parseVerdictOutput", () => {
  test("parses valid JSON with ok:true", () => {
    const result = parseVerdictOutput('{ "ok": true, "reason": "Looks safe" }');
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("Looks safe");
  });

  test("parses valid JSON with ok:false", () => {
    const result = parseVerdictOutput('{ "ok": false, "reason": "Dangerous operation" }');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Dangerous operation");
  });

  test("parses valid JSON without reason field", () => {
    const result = parseVerdictOutput('{ "ok": true }');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("returns ok:true for approval keyword in non-JSON text", () => {
    expect(parseVerdictOutput("This looks ok to me").ok).toBe(true);
    expect(parseVerdictOutput("APPROVED").ok).toBe(true);
    expect(parseVerdictOutput("I'll pass this through").ok).toBe(true);
    expect(parseVerdictOutput("continue with the action").ok).toBe(true);
    expect(parseVerdictOutput("ALLOW this").ok).toBe(true);
    expect(parseVerdictOutput("yes").ok).toBe(true);
  });

  test("returns ok:false with raw text as reason for non-approval text", () => {
    const result = parseVerdictOutput("This is dangerous and should be blocked");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("This is dangerous and should be blocked");
  });

  test("handles whitespace-padded input", () => {
    const result = parseVerdictOutput('  \n  { "ok": true }  \n  ');
    expect(result.ok).toBe(true);
  });

  test("treats falsy ok value as false", () => {
    const result = parseVerdictOutput('{ "ok": false, "reason": "nope" }');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("nope");
  });
});

describe("mapVerdictToDecision", () => {
  test("maps ok:true to continue verdict", () => {
    const decision = mapVerdictToDecision({ ok: true });
    expect(decision.kind).toBe("continue");
  });

  test("maps ok:false with reason to block verdict", () => {
    const decision = mapVerdictToDecision({ ok: false, reason: "Too risky" });
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") {
      expect(decision.reason).toBe("Too risky");
    }
  });

  test("provides default reason when ok:false without reason", () => {
    const decision = mapVerdictToDecision({ ok: false });
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") {
      expect(decision.reason).toBe("Blocked by prompt hook");
    }
  });
});
