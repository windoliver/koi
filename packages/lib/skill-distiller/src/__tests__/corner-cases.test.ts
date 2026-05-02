import { describe, expect, test } from "bun:test";
import { createDistiller } from "../distiller.js";
import { computeDraftHash, computeSourceHash } from "../hash.js";
import { parseSkillDraft } from "../parse.js";
import { createStagingQueue } from "../staging.js";
import { createSkillStore } from "../store.js";
import type { DistillationRecord, DistillationTrace, DistillerLLM, SkillDraft } from "../types.js";

const VALID_DRAFT: SkillDraft = {
  name: "noop",
  description: "A no-op test draft.",
  triggers: ["noop"],
  parameters: [],
  toolSequence: [],
  expectedInputs: [],
  expectedOutputs: [],
};

const okLLM =
  (output: SkillDraft): DistillerLLM =>
  async () => ({ ok: true, value: JSON.stringify(output) });

describe("hash invariants (property-style)", () => {
  test("computeDraftHash is stable when parameters arrive in different order", () => {
    const params = [
      { name: "a", description: "x", required: true },
      { name: "b", description: "y", required: false },
    ];
    const a = computeDraftHash({ ...VALID_DRAFT, parameters: params });
    const b = computeDraftHash({ ...VALID_DRAFT, parameters: [...params].reverse() });
    expect(a).toBe(b);
  });

  test("computeDraftHash is stable when triggers / expectedInputs arrive in different order", () => {
    const a = computeDraftHash({
      ...VALID_DRAFT,
      triggers: ["alpha", "beta"],
      expectedInputs: ["foo", "bar"],
    });
    const b = computeDraftHash({
      ...VALID_DRAFT,
      triggers: ["beta", "alpha"],
      expectedInputs: ["bar", "foo"],
    });
    expect(a).toBe(b);
  });

  test("computeDraftHash MOVES when toolSequence order changes (procedure order matters)", () => {
    const a = computeDraftHash({ ...VALID_DRAFT, toolSequence: ["x", "y"] });
    const b = computeDraftHash({ ...VALID_DRAFT, toolSequence: ["y", "x"] });
    expect(a).not.toBe(b);
  });

  test("computeDraftHash MOVES when a parameter's `required` flips (contract change)", () => {
    const a = computeDraftHash({
      ...VALID_DRAFT,
      parameters: [{ name: "p", description: "d", required: true }],
    });
    const b = computeDraftHash({
      ...VALID_DRAFT,
      parameters: [{ name: "p", description: "d", required: false }],
    });
    expect(a).not.toBe(b);
  });

  test("computeDraftHash IGNORES description (prose) changes — by design", () => {
    const a = computeDraftHash({ ...VALID_DRAFT, description: "alpha" });
    const b = computeDraftHash({ ...VALID_DRAFT, description: "beta — totally different" });
    expect(a).toBe(b);
  });

  test("computeSourceHash differs when ANY turn text changes", () => {
    const base: DistillationTrace = {
      traceId: "t",
      turns: [{ role: "assistant", text: "hi" }],
    };
    const mutated: DistillationTrace = {
      traceId: "t",
      turns: [{ role: "assistant", text: "hello" }],
    };
    expect(computeSourceHash(base)).not.toBe(computeSourceHash(mutated));
  });
});

describe("parse — adversarial LLM output", () => {
  const VALID_JSON = JSON.stringify({
    name: "format-pr",
    description: "Format a PR.",
    triggers: ["format pr"],
    parameters: [],
    toolSequence: ["read_file"],
    expectedInputs: [],
    expectedOutputs: [],
  });

  test("rejects empty string", () => {
    expect(parseSkillDraft("").ok).toBe(false);
  });

  test("rejects deeply nested non-object root (array of object)", () => {
    expect(parseSkillDraft(JSON.stringify([{ name: "x" }])).ok).toBe(false);
  });

  test("rejects name with surrogate pair / non-kebab", () => {
    const bad = JSON.stringify({ ...JSON.parse(VALID_JSON), name: "name-🚀" });
    expect(parseSkillDraft(bad).ok).toBe(false);
  });

  test("rejects single-character valid name (kebab pattern allows it)", () => {
    // Sanity: pattern is /^[a-z0-9][a-z0-9-]{0,39}$/ so "a" is valid.
    const ok = JSON.stringify({ ...JSON.parse(VALID_JSON), name: "a" });
    expect(parseSkillDraft(ok).ok).toBe(true);
  });

  test("rejects name with leading hyphen", () => {
    const bad = JSON.stringify({ ...JSON.parse(VALID_JSON), name: "-bad" });
    expect(parseSkillDraft(bad).ok).toBe(false);
  });

  test("rejects parameter description longer than per-field cap", () => {
    const bad = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      parameters: [{ name: "p", description: "x".repeat(500), required: true }],
    });
    const r = parseSkillDraft(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_PARAMETER_DESCRIPTION_TOO_LONG");
  });

  test("rejects toolSequence with too many entries", () => {
    const bad = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      toolSequence: Array.from({ length: 100 }, (_, i) => `t${i}`),
    });
    const r = parseSkillDraft(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_TOOL_SEQUENCE_TOO_LONG");
  });
});

describe("store — concurrency + LRU+hash interaction", () => {
  const rec = (name: string, hash: string): DistillationRecord => ({
    draft: { ...VALID_DRAFT, name, toolSequence: [name] },
    source: { traceId: name, timestamp: 0, sourceHash: `s-${name}` },
    draftHash: hash,
  });

  test("LRU eviction cleans byHash so an evicted hash can be re-added under a new name", () => {
    const s = createSkillStore({ maxSize: 2 });
    s.add(rec("a", "h1"));
    s.add(rec("b", "h2"));
    // Evicts "a".
    s.add(rec("c", "h3"));
    expect(s.has("a")).toBe(false);
    // h1 is now free — re-adding under a new name must succeed (not be
    // misclassified as a duplicate of the evicted entry).
    expect(s.add(rec("d", "h1"))).toBe("added");
  });

  test("clear() resets both name and hash indices", () => {
    const s = createSkillStore();
    s.add(rec("a", "h"));
    s.clear();
    expect(s.size()).toBe(0);
    // Adding the same hash under a new name must be "added", not "duplicate".
    expect(s.add(rec("b", "h"))).toBe("added");
  });

  test("replace policy refreshes byHash so subsequent same-content adds dedupe to the NEW name", () => {
    const s = createSkillStore({ onConflict: "replace" });
    s.add(rec("alpha", "h-old"));
    expect(s.add(rec("alpha", "h-new"))).toBe("replaced");
    // h-old should no longer claim a slot.
    expect(s.add(rec("beta", "h-old"))).toBe("added");
    // h-new claims "alpha" — adding under another name should dedupe.
    expect(s.add(rec("gamma", "h-new"))).toBe("duplicate");
  });
});

describe("staging — state machine edge cases", () => {
  const rec = (id: string): DistillationRecord => ({
    draft: { ...VALID_DRAFT, name: id },
    source: { traceId: id, timestamp: 0, sourceHash: `s-${id}` },
    draftHash: id,
  });

  test("approve on non-existent id returns undefined and does not create an entry", () => {
    const q = createStagingQueue();
    expect(q.approve("ghost")).toBeUndefined();
    expect(q.get("ghost")).toBeUndefined();
  });

  test("re-approving a pending entry is fine; re-approving an approved entry is a no-op", () => {
    const q = createStagingQueue();
    q.stage(rec("h"));
    expect(q.approve("h")?.status).toBe("approved");
    expect(q.approve("h")).toBeUndefined();
  });

  test("stage of an already-approved id returns the existing approved entry untouched", () => {
    const q = createStagingQueue();
    q.stage(rec("h"));
    q.approve("h");
    const existing = q.stage(rec("h"));
    expect(existing.status).toBe("approved");
  });
});

describe("distiller — boundary inputs", () => {
  test("trace whose only turn is empty assistant text still distills", async () => {
    const trace: DistillationTrace = {
      traceId: "t",
      turns: [{ role: "assistant", text: "" }],
    };
    const llm: DistillerLLM = async () =>
      ({
        ok: true,
        value: JSON.stringify({ ...VALID_DRAFT, toolSequence: [], triggers: ["x"] }),
      }) as const;
    const r = await createDistiller({ allowUnredactedTrace: true, llm }).distill(trace);
    // toolSequence empty → DRAFT_TOOLS_EMPTY (graceful, not a throw).
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_TOOLS_EMPTY");
  });

  test("trace with NaN tool arg (post-JSON.parse) is treated as a constant scalar", async () => {
    // JSON.parse(NaN) throws — but JSON.stringify({x: NaN}) yields {"x":null}.
    // We pass null directly; the distiller sees a constant and accepts.
    const trace: DistillationTrace = {
      traceId: "t",
      turns: [
        { role: "user", text: "do it" },
        { role: "assistant", toolCalls: [{ name: "tick", argsJson: '{"x":null}' }] },
      ],
    };
    const llm: DistillerLLM = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["tick"],
      triggers: ["tick"],
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm }).distill(trace);
    expect(r.ok).toBe(true);
  });

  test("trace with very deep nesting (5 levels) does not stack-overflow grounding", async () => {
    const deep = '{"a":{"b":{"c":{"d":{"e":"/tenant-x/data"}}}}}';
    const trace: DistillationTrace = {
      traceId: "t-deep",
      turns: [
        { role: "user", text: "deep call" },
        { role: "assistant", toolCalls: [{ name: "delete", argsJson: deep }] },
      ],
    };
    // No param → must reject (resource literal hidden 5 levels deep).
    const llm: DistillerLLM = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["delete"],
      triggers: ["delete"],
      parameters: [],
    });
    const r = await createDistiller({ allowUnredactedTrace: true, llm }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_VARIABLE_ARG_UNPARAMETERIZED");
  });

  test("toolCalls turn with empty toolCalls array does not crash grounding", async () => {
    const trace: DistillationTrace = {
      traceId: "t",
      turns: [
        { role: "user", text: "hi" },
        { role: "assistant", toolCalls: [] },
      ],
    };
    const llm: DistillerLLM = async () =>
      ({
        ok: true,
        value: JSON.stringify({ ...VALID_DRAFT, toolSequence: [], triggers: ["x"] }),
      }) as const;
    const r = await createDistiller({ allowUnredactedTrace: true, llm }).distill(trace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_TOOLS_EMPTY");
  });
});

describe("distiller — idempotence property", () => {
  test("calling distill twice on the same trace produces the same draftHash", async () => {
    const trace: DistillationTrace = {
      traceId: "t-idem",
      turns: [
        { role: "user", text: "go" },
        { role: "assistant", toolCalls: [{ name: "step", argsJson: "{}" }] },
      ],
    };
    const llm = okLLM({ ...VALID_DRAFT, toolSequence: ["step"], triggers: ["go"] });
    const d = createDistiller({ allowUnredactedTrace: true, llm });
    const r1 = await d.distill(trace);
    const r2 = await d.distill(trace);
    if (!r1.ok || !r2.ok) throw new Error("expected both ok");
    expect(r1.value.draftHash).toBe(r2.value.draftHash);
  });

  test("distill is order-independent for parameters in the LLM output", async () => {
    const trace: DistillationTrace = {
      traceId: "t-order",
      turns: [
        { role: "user", text: "go" },
        { role: "assistant", toolCalls: [{ name: "step", argsJson: "{}" }] },
      ],
    };
    const a = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["step"],
      triggers: ["go"],
      parameters: [
        { name: "x", description: "x", required: true },
        { name: "y", description: "y", required: false },
      ],
    });
    const b = okLLM({
      ...VALID_DRAFT,
      toolSequence: ["step"],
      triggers: ["go"],
      parameters: [
        { name: "y", description: "y", required: false },
        { name: "x", description: "x", required: true },
      ],
    });
    const r1 = await createDistiller({ allowUnredactedTrace: true, llm: a }).distill(trace);
    const r2 = await createDistiller({ allowUnredactedTrace: true, llm: b }).distill(trace);
    if (!r1.ok || !r2.ok) throw new Error("expected both ok");
    expect(r1.value.draftHash).toBe(r2.value.draftHash);
  });
});

describe("distiller — redactor robustness", () => {
  test("redactor that throws surfaces as a thrown error from createDistiller, not a Result", async () => {
    const trace: DistillationTrace = {
      traceId: "t",
      turns: [{ role: "user", text: "hi" }],
    };
    const llm: DistillerLLM = async () => ({ ok: true, value: JSON.stringify(VALID_DRAFT) });
    const exploding = (): DistillationTrace => {
      throw new Error("redactor blew up");
    };
    const d = createDistiller({ llm, redactor: exploding });
    expect(d.distill(trace)).rejects.toThrow(/redactor blew up/);
  });

  test("redactor returning a trace with extra unknown fields is tolerated", async () => {
    const trace: DistillationTrace = {
      traceId: "t",
      turns: [
        { role: "user", text: "go" },
        { role: "assistant", toolCalls: [{ name: "step", argsJson: "{}" }] },
      ],
    };
    const padding = (t: DistillationTrace): DistillationTrace =>
      ({ ...t, junk: "ignored" }) as unknown as DistillationTrace;
    const llm = okLLM({ ...VALID_DRAFT, toolSequence: ["step"], triggers: ["go"] });
    const r = await createDistiller({ llm, redactor: padding }).distill(trace);
    expect(r.ok).toBe(true);
  });
});
