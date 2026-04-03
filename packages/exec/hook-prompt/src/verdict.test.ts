import { describe, expect, test } from "bun:test";
import { mapVerdictToDecision, parseVerdictOutput, VerdictParseError } from "./verdict.js";

describe("parseVerdictOutput", () => {
  // ── Valid JSON with boolean ok ──

  test("accepts { ok: true } as approval", () => {
    const result = parseVerdictOutput('{ "ok": true }');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("accepts { ok: true, reason } as approval with reason", () => {
    const result = parseVerdictOutput('{ "ok": true, "reason": "Looks safe" }');
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("Looks safe");
  });

  test("accepts { ok: false, reason } as rejection", () => {
    const result = parseVerdictOutput('{ "ok": false, "reason": "Dangerous operation" }');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Dangerous operation");
  });

  test("handles whitespace-padded JSON", () => {
    const result = parseVerdictOutput('  \n  { "ok": true }  \n  ');
    expect(result.ok).toBe(true);
  });

  // ── String boolean coercion — preserves model intent ──

  test('coerces { ok: "false" } to false (model intent: deny)', () => {
    const result = parseVerdictOutput('{ "ok": "false", "reason": "block this" }');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("block this");
  });

  test('coerces { ok: "true" } to true (model intent: approve)', () => {
    const result = parseVerdictOutput('{ "ok": "true" }');
    expect(result.ok).toBe(true);
  });

  // ── Common LLM wrappers — should extract JSON successfully ──

  test("extracts JSON from code fence", () => {
    const input = '```json\n{ "ok": true, "reason": "safe" }\n```';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("safe");
  });

  test("extracts JSON from bare code fence (no language tag)", () => {
    const input = '```\n{ "ok": false, "reason": "blocked" }\n```';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("blocked");
  });

  test("extracts JSON from preamble text", () => {
    const input = 'Here is my verdict:\n{ "ok": true, "reason": "looks good" }';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("looks good");
  });

  test("extracts JSON from preamble + postamble text", () => {
    const input = 'After review:\n{ "ok": false, "reason": "risky" }\nEnd of analysis.';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("risky");
  });

  test("extracts JSON from fenced block with preamble", () => {
    const input = 'My analysis:\n```json\n{ "ok": true }\n```\nDone.';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(true);
  });

  // ── Multiple {…} segments — balanced extraction picks the first object ──

  test("extracts first JSON object when multiple braced segments exist", () => {
    const input = 'Verdict: { "ok": false, "reason": "unsafe" }\nContext: { "info": "details" }';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unsafe");
  });

  test("handles verdict followed by braced text in postamble", () => {
    const input = 'Here: { "ok": true, "reason": "fine" } and some {extra} braces after.';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("fine");
  });

  test("handles nested braces inside JSON values", () => {
    const input = '{ "ok": false, "reason": "blocked {user} input" }';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("blocked {user} input");
  });

  test("finds valid verdict after earlier invalid JSON object", () => {
    const input = 'Here is the schema: {"approved":true}\nFinal verdict: {"ok":true}';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(true);
  });

  test("finds valid verdict after earlier unrelated JSON object", () => {
    const input =
      'Context: {"user":"admin","action":"delete"}\nVerdict: {"ok":false,"reason":"risky"}';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("risky");
  });

  test("finds verdict when response starts with unrelated JSON object", () => {
    const input = '{"meta":"info"}\n{"ok":false,"reason":"denied"}';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("denied");
  });

  test("finds verdict after fenced block followed by later verdict", () => {
    const input = '```json\n{"schema":"example"}\n```\nActual verdict: {"ok":true,"reason":"safe"}';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("safe");
  });

  // ── Non-coercible ok values — must throw VerdictParseError ──

  test("throws on { ok: 1 } — number is not coercible", () => {
    expect(() => parseVerdictOutput('{ "ok": 1 }')).toThrow(VerdictParseError);
  });

  test("throws on { ok: null } — null is not coercible", () => {
    expect(() => parseVerdictOutput('{ "ok": null }')).toThrow(VerdictParseError);
  });

  test('throws on { ok: "yes" } — arbitrary string is not coercible', () => {
    expect(() => parseVerdictOutput('{ "ok": "yes" }')).toThrow(VerdictParseError);
  });

  // ── Plain-text denial — blocks instead of throwing ──

  test("plain-text denial returns ok:false (not routed through failMode)", () => {
    const result = parseVerdictOutput("This is dangerous and should be blocked");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("This is dangerous and should be blocked");
  });

  test("plain-text 'not ok' returns ok:false", () => {
    const result = parseVerdictOutput("not ok — this action is risky");
    expect(result.ok).toBe(false);
  });

  test("plain-text 'unsafe' returns ok:false", () => {
    const result = parseVerdictOutput("This operation is unsafe");
    expect(result.ok).toBe(false);
  });

  test("plain-text 'No, ...' returns ok:false", () => {
    const result = parseVerdictOutput("No, this should not proceed");
    expect(result.ok).toBe(false);
  });

  test("plain-text 'prohibited' returns ok:false", () => {
    const result = parseVerdictOutput("This action is prohibited");
    expect(result.ok).toBe(false);
  });

  test("plain-text 'disallowed' returns ok:false", () => {
    const result = parseVerdictOutput("Operation disallowed by policy");
    expect(result.ok).toBe(false);
  });

  test("plain-text 'harmful' returns ok:false", () => {
    const result = parseVerdictOutput("This could be harmful");
    expect(result.ok).toBe(false);
  });

  test("plain-text 'risky' returns ok:false", () => {
    const result = parseVerdictOutput("This seems risky");
    expect(result.ok).toBe(false);
  });

  test("plain-text 'rejected' returns ok:false", () => {
    const result = parseVerdictOutput("Action rejected — too risky");
    expect(result.ok).toBe(false);
  });

  test("plain-text 'forbidden' returns ok:false", () => {
    const result = parseVerdictOutput("This operation is forbidden");
    expect(result.ok).toBe(false);
  });

  // ── Benign "no" phrases — must NOT block (routed through failMode) ──

  test("'No issues detected' throws (benign approval, not denial)", () => {
    expect(() => parseVerdictOutput("No issues detected")).toThrow(VerdictParseError);
  });

  test("'No concerns' throws (benign approval, not denial)", () => {
    expect(() => parseVerdictOutput("No concerns with this action")).toThrow(VerdictParseError);
  });

  test("'No problems found' throws (benign approval, not denial)", () => {
    expect(() => parseVerdictOutput("No problems found")).toThrow(VerdictParseError);
  });

  test("'No risks identified' throws (benign approval, not denial)", () => {
    expect(() => parseVerdictOutput("No risks identified")).toThrow(VerdictParseError);
  });

  test("'no' inside a word does not trigger denial ('notion')", () => {
    expect(() => parseVerdictOutput("I have a notion this is fine")).toThrow(VerdictParseError);
  });

  // ── Mixed benign "no" + later denial — denial still wins ──

  test("'No issues detected, but do not proceed' is denial", () => {
    const result = parseVerdictOutput("No issues detected, but do not proceed");
    expect(result.ok).toBe(false);
  });

  test("'No concerns on format; this is dangerous' is denial", () => {
    const result = parseVerdictOutput("No concerns on format; this is dangerous");
    expect(result.ok).toBe(false);
  });

  test("'No problems found but action is unsafe' is denial", () => {
    const result = parseVerdictOutput("No problems found but action is unsafe");
    expect(result.ok).toBe(false);
  });

  // ── Plain-text approval — requires structured JSON, not accepted as plain text ──

  test("plain-text 'Approved' throws (approvals require JSON)", () => {
    expect(() => parseVerdictOutput("Approved")).toThrow(VerdictParseError);
  });

  test("plain-text 'yes' throws (approvals require JSON)", () => {
    expect(() => parseVerdictOutput("yes")).toThrow(VerdictParseError);
  });

  test("plain-text 'ok' throws (approvals require JSON)", () => {
    expect(() => parseVerdictOutput("ok")).toThrow(VerdictParseError);
  });

  test("qualified approval throws (not silently upgraded to allow)", () => {
    expect(() => parseVerdictOutput("proceed only after confirming backup")).toThrow(
      VerdictParseError,
    );
  });

  // ── Negated approvals — still detected as denial ──

  test("'Do not proceed' is denial", () => {
    const result = parseVerdictOutput("Do not proceed with this action");
    expect(result.ok).toBe(false);
  });

  test("'not acceptable' is denial", () => {
    const result = parseVerdictOutput("This is not acceptable");
    expect(result.ok).toBe(false);
  });

  test("'cannot continue' is denial", () => {
    const result = parseVerdictOutput("We cannot continue here");
    expect(result.ok).toBe(false);
  });

  test("'don't allow' is denial", () => {
    const result = parseVerdictOutput("don't allow this action");
    expect(result.ok).toBe(false);
  });

  test("'never proceed' is denial", () => {
    const result = parseVerdictOutput("never proceed with deletion");
    expect(result.ok).toBe(false);
  });

  // ── Ambiguous plain text — throws VerdictParseError (routed through failMode) ──

  test("throws on ambiguous plain text with no denial or JSON", () => {
    expect(() => parseVerdictOutput("This looks fine to me")).toThrow(VerdictParseError);
  });

  test("throws on empty string", () => {
    expect(() => parseVerdictOutput("")).toThrow(VerdictParseError);
  });

  test("throws on whitespace-only string", () => {
    expect(() => parseVerdictOutput("   \n  ")).toThrow(VerdictParseError);
  });

  // ── Mixed denial text + malformed JSON — denial dominates ──

  test("denial text with malformed fenced JSON returns ok:false", () => {
    const input = "This is dangerous.\n```json\n{ invalid json }\n```";
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("dangerous");
  });

  test("denial text with unrelated braced text returns ok:false", () => {
    const input = "This action is unsafe. Here is context: {some broken stuff}";
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(false);
  });

  test("denial text with JSON missing ok field returns ok:false", () => {
    const input = 'Rejected. { "status": "denied" }';
    const result = parseVerdictOutput(input);
    expect(result.ok).toBe(false);
  });

  test("ambiguous text with malformed JSON still throws", () => {
    const input = "I think this is fine. { broken json }";
    expect(() => parseVerdictOutput(input)).toThrow(VerdictParseError);
  });

  // ── JSON without ok field — must throw ──

  test("throws on JSON object without ok field", () => {
    expect(() => parseVerdictOutput('{ "approved": true }')).toThrow(VerdictParseError);
  });

  test("throws on JSON array", () => {
    expect(() => parseVerdictOutput("[true]")).toThrow(VerdictParseError);
  });

  // ── Malformed ok inside wrappers — still rejected or coerced correctly ──

  test("coerces string boolean inside code fence", () => {
    const result = parseVerdictOutput('```json\n{ "ok": "false", "reason": "no" }\n```');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no");
  });

  test("throws on non-coercible ok inside code fence", () => {
    expect(() => parseVerdictOutput('```json\n{ "ok": 0 }\n```')).toThrow(VerdictParseError);
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
