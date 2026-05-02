import { describe, expect, test } from "bun:test";
import { createDistiller } from "./distiller.js";
import type { DistillationTrace, DistillerLLM, SkillDraft } from "./types.js";

const VALID_DRAFT: SkillDraft = {
  name: "format-pr",
  description: "Format a PR.",
  triggers: ["format pr"],
  parameters: [{ name: "title", description: "title", required: true }],
  toolSequence: ["read_file", "write_file"],
  expectedInputs: ["pr number"],
  expectedOutputs: ["formatted markdown"],
};

const TRACE: DistillationTrace = {
  traceId: "t1",
  sessionId: "s1",
  turns: [
    { role: "user", text: "format pr 42" },
    { role: "assistant", toolCalls: [{ name: "read_file", argsJson: "{}" }] },
    { role: "tool", text: "ok" },
    { role: "assistant", toolCalls: [{ name: "write_file", argsJson: "{}" }] },
    { role: "tool", text: "ok" },
    { role: "assistant", text: "done" },
  ],
};

const SINGLE_TOOL_TRACE: DistillationTrace = {
  traceId: "t-single",
  sessionId: "s1",
  turns: [
    { role: "user", text: "hi" },
    { role: "assistant", toolCalls: [{ name: "read_file", argsJson: "{}" }] },
  ],
};

const okLLM =
  (output: SkillDraft): DistillerLLM =>
  async () => ({ ok: true, value: JSON.stringify(output) });

describe("createDistiller", () => {
  test("returns a record with stable hashes for valid trace", async () => {
    const d = createDistiller({ llm: okLLM(VALID_DRAFT), now: () => 1700000000000 });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.draft.name).toBe("format-pr");
    expect(r.value.draftHash.length).toBeGreaterThan(0);
    expect(r.value.source.timestamp).toBe(1700000000000);
    expect(r.value.source.traceId).toBe("t1");
    expect(r.value.source.sessionId).toBe("s1");
  });

  test("rejects empty trace before calling LLM", async () => {
    let calls = 0;
    const llm: DistillerLLM = async () => {
      calls += 1;
      return { ok: true, value: "{}" };
    };
    const d = createDistiller({ llm });
    const r = await d.distill({ traceId: "t", turns: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("TRACE_EMPTY");
    expect(calls).toBe(0);
  });

  test("propagates LLM failure as EXTERNAL with cause code", async () => {
    const llm: DistillerLLM = async () => ({
      ok: false,
      error: { code: "RATE_LIMIT", message: "slow down", retryable: true },
    });
    const d = createDistiller({ llm });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("EXTERNAL");
      expect(r.error.context?.causeCode).toBe("RATE_LIMIT");
    }
  });

  test("preserves retryable=true when wrapping a transient LLM failure", async () => {
    const llm: DistillerLLM = async () => ({
      ok: false,
      error: { code: "RATE_LIMIT", message: "slow down", retryable: true },
    });
    const d = createDistiller({ llm });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.retryable).toBe(true);
  });

  test("preserves retryable=false when wrapping a terminal LLM failure", async () => {
    const llm: DistillerLLM = async () => ({
      ok: false,
      error: { code: "INTERNAL", message: "bug", retryable: false },
    });
    const d = createDistiller({ llm });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.retryable).toBe(false);
  });

  test("propagates parse failure as VALIDATION", async () => {
    const llm: DistillerLLM = async () => ({ ok: true, value: "not json" });
    const d = createDistiller({ llm });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects draft whose toolSequence references tools not in the trace", async () => {
    const d = createDistiller({ llm: okLLM(VALID_DRAFT) });
    const r = await d.distill(SINGLE_TOOL_TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("VALIDATION");
      expect(r.error.context?.errorKind).toBe("DRAFT_TOOL_NOT_GROUNDED");
    }
  });

  test("rejects draft with empty toolSequence", async () => {
    const d = createDistiller({ llm: okLLM({ ...VALID_DRAFT, toolSequence: [] }) });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_TOOLS_EMPTY");
  });

  test("rejects draft with empty triggers (un-discoverable skill)", async () => {
    const d = createDistiller({ llm: okLLM({ ...VALID_DRAFT, triggers: [] }) });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_TRIGGERS_EMPTY");
  });

  test("omits sessionId from source when trace has none", async () => {
    const d = createDistiller({ llm: okLLM({ ...VALID_DRAFT, toolSequence: ["read_file"] }) });
    const r = await d.distill({
      traceId: "t1",
      turns: [{ role: "assistant", toolCalls: [{ name: "read_file", argsJson: "{}" }] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.source.sessionId).toBeUndefined();
  });
});
