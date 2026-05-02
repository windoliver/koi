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
    const d = createDistiller({
      allowUnredactedTrace: true,
      llm: okLLM(VALID_DRAFT),
      now: () => 1700000000000,
    });
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
    const d = createDistiller({ allowUnredactedTrace: true, llm });
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
    const d = createDistiller({ allowUnredactedTrace: true, llm });
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
    const d = createDistiller({ allowUnredactedTrace: true, llm });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.retryable).toBe(true);
  });

  test("preserves retryable=false when wrapping a terminal LLM failure", async () => {
    const llm: DistillerLLM = async () => ({
      ok: false,
      error: { code: "INTERNAL", message: "bug", retryable: false },
    });
    const d = createDistiller({ allowUnredactedTrace: true, llm });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.retryable).toBe(false);
  });

  test("propagates parse failure as VALIDATION", async () => {
    const llm: DistillerLLM = async () => ({ ok: true, value: "not json" });
    const d = createDistiller({ allowUnredactedTrace: true, llm });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects draft whose toolSequence references tools not in the trace", async () => {
    const d = createDistiller({ allowUnredactedTrace: true, llm: okLLM(VALID_DRAFT) });
    const r = await d.distill(SINGLE_TOOL_TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("VALIDATION");
      expect(r.error.context?.errorKind).toBe("DRAFT_TOOL_NOT_GROUNDED");
    }
  });

  test("rejects draft whose toolSequence is in the wrong order", async () => {
    // TRACE invokes read_file then write_file. Reverse order is rejected.
    const reordered = okLLM({ ...VALID_DRAFT, toolSequence: ["write_file", "read_file"] });
    const d = createDistiller({ allowUnredactedTrace: true, llm: reordered });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_TOOL_NOT_GROUNDED");
  });

  test("accepts draft that is a contiguous prefix of the observed sequence", async () => {
    // TRACE observed = [read_file, write_file]. A draft of just [read_file]
    // captures the leading sub-procedure and is a valid contiguous prefix.
    const prefix = okLLM({ ...VALID_DRAFT, toolSequence: ["read_file"] });
    const d = createDistiller({ allowUnredactedTrace: true, llm: prefix });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(true);
  });

  test("rejects draft that is a suffix (drops leading guard/setup steps)", async () => {
    // TRACE observed = [read_file, write_file]. Distilling to just [write_file]
    // would silently strip the read_file prerequisite — disallowed.
    const suffix = okLLM({ ...VALID_DRAFT, toolSequence: ["write_file"] });
    const d = createDistiller({ allowUnredactedTrace: true, llm: suffix });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_TOOL_NOT_GROUNDED");
  });

  test("rejects draft that burns a trace-specific path into description", async () => {
    const traceWithPath: DistillationTrace = {
      traceId: "t-leak",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"/etc/secret-tenant-data.yaml"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "write_file", argsJson: '{"path":"/tmp/out"}' }],
        },
      ],
    };
    const burned = okLLM({
      ...VALID_DRAFT,
      description: "Read /etc/secret-tenant-data.yaml and write the formatted result.",
    });
    const d = createDistiller({ allowUnredactedTrace: true, llm: burned });
    const r = await d.distill(traceWithPath);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_LITERAL_LEAKED");
  });

  test("rejects draft that burns a trace literal into expectedInputs", async () => {
    const trace: DistillationTrace = {
      traceId: "t-leak",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"id":"acct-77c19ab3"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "write_file", argsJson: "{}" }],
        },
      ],
    };
    const burned = okLLM({ ...VALID_DRAFT, expectedInputs: ["account acct-77c19ab3"] });
    const d = createDistiller({ allowUnredactedTrace: true, llm: burned });
    const r = await d.distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_LITERAL_LEAKED");
  });

  test("rejects draft with trace literal leaked into a trigger phrase", async () => {
    const trace: DistillationTrace = {
      traceId: "t",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"acct-77c19ab3"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "write_file", argsJson: "{}" }],
        },
      ],
    };
    const burned = okLLM({ ...VALID_DRAFT, triggers: ["format pr for acct-77c19ab3"] });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: burned }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_LITERAL_LEAKED");
  });

  test("rejects draft with trace literal leaked into a parameter description", async () => {
    const trace: DistillationTrace = {
      traceId: "t",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"/srv/tenant-9/data"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "write_file", argsJson: "{}" }],
        },
      ],
    };
    const burned = okLLM({
      ...VALID_DRAFT,
      parameters: [{ name: "title", description: "the path /srv/tenant-9/data", required: true }],
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: burned }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_LITERAL_LEAKED");
  });

  test("redactor runs before LLM call — secrets in tool args never reach the prompt", async () => {
    const trace: DistillationTrace = {
      traceId: "t-secret",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"token":"sk-secret-XYZ"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "write_file", argsJson: "{}" }],
        },
      ],
    };
    let promptSeen = "";
    const llm: DistillerLLM = async ({ prompt }) => {
      promptSeen = prompt;
      return { ok: true, value: JSON.stringify({ ...VALID_DRAFT, toolSequence: ["read_file"] }) };
    };
    const redactor = (t: DistillationTrace): DistillationTrace => ({
      ...t,
      turns: t.turns.map((turn) =>
        turn.toolCalls === undefined
          ? turn
          : {
              ...turn,
              toolCalls: turn.toolCalls.map((c) => ({
                name: c.name,
                argsJson: c.argsJson.replace(/sk-[A-Za-z0-9-]+/g, "<redacted>"),
              })),
            },
      ),
    });
    const r = await createDistiller({ llm, redactor }).distill(trace);
    expect(r.ok).toBe(true);
    expect(promptSeen).not.toContain("sk-secret-XYZ");
    expect(promptSeen).toContain("<redacted>");
  });

  test("normalizes thrown LLM exceptions into EXTERNAL Result error (not a rejection)", async () => {
    const llm: DistillerLLM = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await createDistiller({ allowUnredactedTrace: true, llm }).distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("EXTERNAL");
      expect(r.error.context?.errorKind).toBe("LLM_THREW");
      expect(r.error.retryable).toBe(true);
    }
  });

  test("accepts draft that abstracts trace literals through parameters", async () => {
    const trace: DistillationTrace = {
      traceId: "t-clean",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"/etc/example.yaml"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "write_file", argsJson: '{"path":"/tmp/out"}' }],
        },
      ],
    };
    // Description references the parameter, not the literal path.
    const generic = okLLM({
      ...VALID_DRAFT,
      description: "Read the input file at {path} and write the formatted result.",
    });
    const d = createDistiller({ allowUnredactedTrace: true, llm: generic });
    const r = await d.distill(trace);
    expect(r.ok).toBe(true);
  });

  test("rejects draft with empty toolSequence", async () => {
    const d = createDistiller({
      allowUnredactedTrace: true,
      llm: okLLM({ ...VALID_DRAFT, toolSequence: [] }),
    });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_TOOLS_EMPTY");
  });

  test("rejects draft with empty triggers (un-discoverable skill)", async () => {
    const d = createDistiller({
      allowUnredactedTrace: true,
      llm: okLLM({ ...VALID_DRAFT, triggers: [] }),
    });
    const r = await d.distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_TRIGGERS_EMPTY");
  });

  test("omits sessionId from source when trace has none", async () => {
    const d = createDistiller({
      allowUnredactedTrace: true,
      llm: okLLM({ ...VALID_DRAFT, toolSequence: ["read_file"] }),
    });
    const r = await d.distill({
      traceId: "t1",
      turns: [{ role: "assistant", toolCalls: [{ name: "read_file", argsJson: "{}" }] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.source.sessionId).toBeUndefined();
  });

  test("throws at construction when neither redactor nor allowUnredactedTrace is set", () => {
    const llm: DistillerLLM = async () => ({ ok: true, value: JSON.stringify(VALID_DRAFT) });
    expect(() => createDistiller({ llm })).toThrow(/redactor/);
  });

  test("deep-clones trace so an in-place redactor cannot mutate the caller's input", async () => {
    const trace: DistillationTrace = {
      traceId: "t-mut",
      turns: [
        { role: "user", text: "hi" },
        { role: "assistant", toolCalls: [{ name: "read_file", argsJson: '{"path":"/x"}' }] },
        { role: "assistant", toolCalls: [{ name: "write_file", argsJson: "{}" }] },
      ],
    };
    const before = JSON.stringify(trace);
    const llm: DistillerLLM = async () => ({ ok: true, value: JSON.stringify(VALID_DRAFT) });
    // Intentionally hostile redactor: mutates whatever it sees in place.
    const redactor = (t: DistillationTrace): DistillationTrace => {
      for (const turn of t.turns) {
        if (turn.toolCalls === undefined) continue;
        for (const c of turn.toolCalls) {
          (c as { argsJson: string }).argsJson = "MUTATED";
        }
      }
      return t;
    };
    const r = await createDistiller({ llm, redactor }).distill(trace);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(trace)).toBe(before);
  });

  test("detects literals leaked through turn.text (not just tool args)", async () => {
    const trace: DistillationTrace = {
      traceId: "t-text-leak",
      turns: [
        { role: "user", text: "process tenant /srv/tenant-99/data please" },
        { role: "assistant", toolCalls: [{ name: "read_file", argsJson: "{}" }] },
        { role: "assistant", toolCalls: [{ name: "write_file", argsJson: "{}" }] },
      ],
    };
    const burned = okLLM({
      ...VALID_DRAFT,
      description: "Process /srv/tenant-99/data and emit a formatted report.",
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: burned }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_LITERAL_LEAKED");
  });

  test("rejects toolSequence that drops intermediate prerequisite steps", async () => {
    // Trace: authorize -> validate -> delete. A draft of [authorize, delete]
    // skips the validation step — this would silently approve unsafe replays.
    const trace: DistillationTrace = {
      traceId: "t-skip",
      turns: [
        { role: "assistant", toolCalls: [{ name: "authorize", argsJson: "{}" }] },
        { role: "assistant", toolCalls: [{ name: "validate", argsJson: "{}" }] },
        { role: "assistant", toolCalls: [{ name: "delete", argsJson: "{}" }] },
      ],
    };
    const dropped = okLLM({ ...VALID_DRAFT, toolSequence: ["authorize", "delete"] });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: dropped }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_TOOL_NOT_GROUNDED");
  });

  test("rejects draft.name that burns in a trace-specific identifier", async () => {
    const trace: DistillationTrace = {
      traceId: "t-name-leak",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"id":"acct-77c19ab3"}' }],
        },
        { role: "assistant", toolCalls: [{ name: "write_file", argsJson: "{}" }] },
      ],
    };
    const burned = okLLM({ ...VALID_DRAFT, name: "acct-77c19ab3-cleanup" });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: burned }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_LITERAL_LEAKED");
  });

  test("marks permanent thrown LLM exceptions (auth, bad request) as non-retryable", async () => {
    const llm: DistillerLLM = async () => {
      throw new Error("401 Unauthorized: invalid api key");
    };
    const r = await createDistiller({ allowUnredactedTrace: true, llm }).distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("EXTERNAL");
      expect(r.error.context?.errorKind).toBe("LLM_THREW");
      expect(r.error.retryable).toBe(false);
    }
  });

  test("detects literal leak even when source tool args are malformed JSON", async () => {
    // The arg string is invalid JSON but still rendered into the prompt
    // verbatim. The leak detector must tokenize the raw string, otherwise
    // a truncated tool call could smuggle a tenant id past validation.
    const trace: DistillationTrace = {
      traceId: "t-bad-args",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"id":"acct-77c19ab3"' }],
        },
        { role: "assistant", toolCalls: [{ name: "write_file", argsJson: "{}" }] },
      ],
    };
    const burned = okLLM({
      ...VALID_DRAFT,
      description: "Cleans up account acct-77c19ab3 once a day.",
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: burned }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_LITERAL_LEAKED");
  });

  test("detects email PII leaked into a draft field", async () => {
    const trace: DistillationTrace = {
      traceId: "t-email",
      turns: [
        { role: "user", text: "follow up with alice@example.com about the report" },
        { role: "assistant", toolCalls: [{ name: "read_file", argsJson: "{}" }] },
        { role: "assistant", toolCalls: [{ name: "write_file", argsJson: "{}" }] },
      ],
    };
    const burned = okLLM({
      ...VALID_DRAFT,
      description: "Send a status update to alice@example.com after formatting.",
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: burned }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_LITERAL_LEAKED");
  });

  test("rejects draft missing a parameter for a tool arg that varies across invocations", async () => {
    // read_file is called twice with different "path" values — that key is
    // variable and must be exposed as a parameter, not baked in.
    const trace: DistillationTrace = {
      traceId: "t-var",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"/srv/a"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"/srv/b"}' }],
        },
      ],
    };
    const noParam = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["read_file", "read_file"],
      parameters: [], // missing "path"
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: noParam }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_VARIABLE_ARG_UNPARAMETERIZED");
  });

  test("rejects draft that reuses one parameter to cover two distinct (tool,key) variable args", async () => {
    // read_file.path varies AND write_file.path varies — independent inputs.
    // A single "path" parameter cannot legitimately satisfy both.
    const trace: DistillationTrace = {
      traceId: "t-shared",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"/in/a"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "write_file", argsJson: '{"path":"/out/x"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"/in/b"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "write_file", argsJson: '{"path":"/out/y"}' }],
        },
      ],
    };
    const oneParam = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["read_file", "write_file", "read_file", "write_file"],
      parameters: [{ name: "path", description: "shared", required: true }],
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: oneParam }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_VARIABLE_ARG_UNPARAMETERIZED");
  });

  test("does NOT treat ordinary long English words in turn.text as trace literals", async () => {
    // "kubernetes", "formatting", and "operations" are common nouns, not
    // identifiers — a generic draft mentioning them must not be flagged.
    const trace: DistillationTrace = {
      traceId: "t-words",
      turns: [
        { role: "user", text: "kubernetes formatting operations workflow please" },
        { role: "assistant", toolCalls: [{ name: "read_file", argsJson: "{}" }] },
        { role: "assistant", toolCalls: [{ name: "write_file", argsJson: "{}" }] },
      ],
    };
    const generic = okLLM({
      ...VALID_DRAFT,
      description: "Format kubernetes operations output for the user.",
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: generic }).distill(trace);
    expect(r.ok).toBe(true);
  });

  test("variable-arg check is scoped to the grounded prefix, not tail calls outside it", async () => {
    // Prefix [read_file, read_file] uses identical paths (constant). A
    // later tail call (write_file) varies its path — but that's outside the
    // distilled prefix and must not invalidate the leading sub-procedure.
    const trace: DistillationTrace = {
      traceId: "t-tail",
      turns: [
        { role: "assistant", toolCalls: [{ name: "read_file", argsJson: '{"path":"/in"}' }] },
        { role: "assistant", toolCalls: [{ name: "read_file", argsJson: '{"path":"/in"}' }] },
        { role: "assistant", toolCalls: [{ name: "write_file", argsJson: '{"path":"/o1"}' }] },
        { role: "assistant", toolCalls: [{ name: "write_file", argsJson: '{"path":"/o2"}' }] },
      ],
    };
    const prefixOnly = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["read_file", "read_file"],
      parameters: [], // no params needed: prefix args are constant
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: prefixOnly }).distill(trace);
    expect(r.ok).toBe(true);
  });

  test("rejects distillation when trace exceeds the prompt budget (would persist a partial procedure)", async () => {
    // 1000 turns each ~150 bytes — well past the 32 KiB prompt budget. The
    // distiller must NOT happily produce a prefix-skill from a truncated
    // prompt; it has to fail closed so the caller can shrink the trace.
    const turns = Array.from({ length: 1000 }, (_, i) => ({
      role: "assistant" as const,
      text: `step ${i}: do a small chunk of work and report back to the user`,
    }));
    const llm: DistillerLLM = async () => ({ ok: true, value: JSON.stringify(VALID_DRAFT) });
    const r = await createDistiller({ allowUnredactedTrace: true, llm }).distill({
      traceId: "huge",
      turns,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("VALIDATION");
      expect(r.error.context?.errorKind).toBe("TRACE_TOO_LARGE");
    }
  });

  test("variable-arg check sees real variability even when redactor collapses values", async () => {
    // Redactor maps both distinct paths to the same placeholder. Grounding
    // must run on the RAW trace so the variability is still detected.
    const trace: DistillationTrace = {
      traceId: "t-collapse",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"/srv/tenant-1/data"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"/srv/tenant-2/data"}' }],
        },
      ],
    };
    const llm: DistillerLLM = async () =>
      ({
        ok: true,
        value: JSON.stringify({
          ...VALID_DRAFT,
          toolSequence: ["read_file", "read_file"],
          parameters: [], // missing the path parameter
        }),
      }) as const;
    const collapsing = (t: DistillationTrace): DistillationTrace => ({
      ...t,
      turns: t.turns.map((turn) =>
        turn.toolCalls === undefined
          ? turn
          : {
              ...turn,
              toolCalls: turn.toolCalls.map((c) => ({
                name: c.name,
                argsJson: c.argsJson.replace(/"\/srv\/[^"]+"/g, '"<redacted>"'),
              })),
            },
      ),
    });
    const r = await createDistiller({ llm, redactor: collapsing }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_VARIABLE_ARG_UNPARAMETERIZED");
  });

  test("variable-arg check tracks tools whose JSON args are top-level arrays", async () => {
    const trace: DistillationTrace = {
      traceId: "t-array",
      turns: [
        { role: "assistant", toolCalls: [{ name: "delete", argsJson: '["/a"]' }] },
        { role: "assistant", toolCalls: [{ name: "delete", argsJson: '["/b"]' }] },
      ],
    };
    const noParam = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["delete", "delete"],
      parameters: [],
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: noParam }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_VARIABLE_ARG_UNPARAMETERIZED");
  });

  test("variable-arg check recurses into nested tool argument structures", async () => {
    // Nested target.path varies — must require a parameter for it.
    const trace: DistillationTrace = {
      traceId: "t-nested",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "delete", argsJson: '{"target":{"path":"/a"}}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "delete", argsJson: '{"target":{"path":"/b"}}' }],
        },
      ],
    };
    const noParam = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["delete", "delete"],
      parameters: [],
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: noParam }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_VARIABLE_ARG_UNPARAMETERIZED");
  });

  test("variable-arg check fails closed when a tool's args are malformed across calls", async () => {
    // Two different malformed strings — we cannot prove they're constant, so
    // the draft must expose a parameter for that tool's inputs.
    const trace: DistillationTrace = {
      traceId: "t-bad-vary",
      turns: [
        { role: "assistant", toolCalls: [{ name: "delete", argsJson: "{ broken-1" }] },
        { role: "assistant", toolCalls: [{ name: "delete", argsJson: "{ broken-2" }] },
      ],
    };
    const noParam = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["delete", "delete"],
      parameters: [],
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: noParam }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_VARIABLE_ARG_UNPARAMETERIZED");
  });

  test("parameter coverage rejects spurious substring matches (grid does not satisfy id)", async () => {
    const trace: DistillationTrace = {
      traceId: "t-tok",
      turns: [
        { role: "assistant", toolCalls: [{ name: "fetch", argsJson: '{"id":"a1"}' }] },
        { role: "assistant", toolCalls: [{ name: "fetch", argsJson: '{"id":"a2"}' }] },
      ],
    };
    const wrong = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["fetch", "fetch"],
      parameters: [{ name: "grid", description: "unrelated", required: true }],
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: wrong }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_VARIABLE_ARG_UNPARAMETERIZED");
  });

  test("sourceHash reflects the redacted trace, not the raw input", async () => {
    const trace: DistillationTrace = {
      traceId: "t-prov",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"token":"sk-secret-XYZ"}' }],
        },
        { role: "assistant", toolCalls: [{ name: "write_file", argsJson: "{}" }] },
      ],
    };
    const llm: DistillerLLM = async () => ({ ok: true, value: JSON.stringify(VALID_DRAFT) });
    const identity = (t: DistillationTrace): DistillationTrace => t;
    const masking = (t: DistillationTrace): DistillationTrace => ({
      ...t,
      turns: t.turns.map((turn) =>
        turn.toolCalls === undefined
          ? turn
          : {
              ...turn,
              toolCalls: turn.toolCalls.map((c) => ({
                name: c.name,
                argsJson: c.argsJson.replace(/sk-[A-Za-z0-9-]+/g, "<redacted>"),
              })),
            },
      ),
    });
    const a = await createDistiller({ llm, redactor: identity }).distill(trace);
    const b = await createDistiller({ llm, redactor: masking }).distill(trace);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      // Different redacted bytes feed the LLM ⇒ different provenance hash.
      expect(a.value.source.sourceHash).not.toBe(b.value.source.sourceHash);
    }
  });

  test("accepts draft whose parameter name covers a variable tool arg", async () => {
    const trace: DistillationTrace = {
      traceId: "t-var-ok",
      turns: [
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"/srv/a"}' }],
        },
        {
          role: "assistant",
          toolCalls: [{ name: "read_file", argsJson: '{"path":"/srv/b"}' }],
        },
      ],
    };
    const withParam = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["read_file", "read_file"],
      parameters: [{ name: "path", description: "file to read", required: true }],
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm: withParam }).distill(trace);
    expect(r.ok).toBe(true);
  });

  test("still marks transient thrown LLM exceptions (timeout, 429) as retryable", async () => {
    const llm: DistillerLLM = async () => {
      throw new Error("429 Too Many Requests");
    };
    const r = await createDistiller({ allowUnredactedTrace: true, llm }).distill(TRACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.retryable).toBe(true);
  });
});
