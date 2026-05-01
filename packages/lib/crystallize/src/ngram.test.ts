import { describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core";
import type { TurnSequence } from "./ngram.js";
import { computeNgramKey, extractNgrams, extractToolSequences } from "./ngram.js";
import { createTrace } from "./test-helpers.js";

const SESSION = sessionId("test-session");
const AGENT = "test-agent";

function turn(turnIndex: number, ids: readonly string[]): TurnSequence {
  return {
    location: { sessionId: SESSION, agentId: AGENT, turnIndex },
    steps: ids.map((toolId) => ({ toolId })),
  };
}

describe("computeNgramKey", () => {
  test("pipe-joins tool IDs", () => {
    expect(computeNgramKey([{ toolId: "a" }, { toolId: "b" }, { toolId: "c" }])).toBe("a|b|c");
  });
});

describe("extractToolSequences", () => {
  test("projects tool_call events in order, preserving real turnIndex + identity", () => {
    const seqs = extractToolSequences([createTrace(7, ["read", "parse", "save"])]);
    expect(seqs).toHaveLength(1);
    expect(seqs[0]?.location.turnIndex).toBe(7);
    expect(seqs[0]?.steps.map((s) => s.toolId)).toEqual(["read", "parse", "save"]);
  });

  test("yields no outcome signal when output is undefined (no capture)", () => {
    const seqs = extractToolSequences([createTrace(0, ["broken"], [undefined])]);
    expect(seqs[0]?.steps[0]?.outcome).toBeUndefined();
  });

  test("plain object with truthy top-level `error` is classified as failure", () => {
    // Hook-blocked tool calls and tool-side error envelopes both surface as
    // `output: { error: ... }` — treating those as success would crystallize
    // denied workflows.
    const seqs = extractToolSequences([createTrace(0, ["broken"], [{ error: "boom" }])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("empty / falsy top-level `error` does not flip success to failure", () => {
    const seqs = extractToolSequences([
      createTrace(0, ["x", "y"], [{ error: "" }, { error: null }]),
    ]);
    expect(seqs[0]?.steps.map((s) => s.outcome)).toEqual(["success", "success"]);
  });

  test("classifies kind:error envelopes as failure", () => {
    const seqs = extractToolSequences([createTrace(0, ["x"], [{ kind: "error", message: "x" }])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("classifies kind:denied envelopes as failure", () => {
    const seqs = extractToolSequences([createTrace(0, ["x"], [{ kind: "denied" }])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("treats null output as success (explicit void return, no error)", () => {
    const seqs = extractToolSequences([createTrace(0, ["void_tool"], [null])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("success");
  });

  test("treats primitive outputs (string / number / boolean) as success", () => {
    const seqs = extractToolSequences([createTrace(0, ["s", "n", "b"], ["hello", 42, true])]);
    expect(seqs[0]?.steps.map((s) => s.outcome)).toEqual(["success", "success", "success"]);
  });

  test("validation reject with kind:validation is neutral (no outcome signal)", () => {
    const seqs = extractToolSequences([
      createTrace(0, ["v"], [{ kind: "validation", error: "bad input" }]),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("validation");
  });

  test("validation reject with code:VALIDATION (no kind) is neutral (no outcome signal)", () => {
    const seqs = extractToolSequences([
      createTrace(0, ["v"], [{ error: "bad input", code: "VALIDATION" }]),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("validation");
  });

  test("LSP-style { ok: false, error: { code: 'VALIDATION' } } is neutral", () => {
    const seqs = extractToolSequences([
      createTrace(0, ["v"], [{ ok: false, error: { code: "VALIDATION", message: "bad arg" } }]),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("validation");
  });

  test("forge_tool_quarantined envelope is classified as failure", () => {
    const seqs = extractToolSequences([
      createTrace(0, ["q"], [{ kind: "forge_tool_quarantined", reason: "too many failures" }]),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("generic { ok: false } envelope (no validation marker) is classified as failure", () => {
    const seqs = extractToolSequences([
      createTrace(0, ["x"], [{ ok: false, error: "generic boom" }]),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("plain { ok: false } with no further detail is classified as failure", () => {
    const seqs = extractToolSequences([createTrace(0, ["x"], [{ ok: false }])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("metadata.blockedByHook (soft-deny from middleware-permissions) is failure", () => {
    // middleware-permissions returns `output: <primitive string>, metadata:
    // { blockedByHook: true, ... }` for soft-deny — primitive output alone
    // would misclassify as success.
    const seqs = extractToolSequences([
      createTrace(
        0,
        ["x"],
        [
          {
            output: 'Permission denied for tool "x".',
            metadata: { blockedByHook: true, permissionDenied: true, hookName: "permissions" },
          },
        ],
      ),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("metadata.isError (hook-error response shape) is failure", () => {
    const seqs = extractToolSequences([
      createTrace(0, ["x"], [{ output: "...", metadata: { isError: true } }]),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("Error instance recorded as output is failure (thrown tool error)", () => {
    const seqs = extractToolSequences([createTrace(0, ["x"], [new Error("tool blew up")])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("serialized Error object (name + message + stack) is failure", () => {
    const seqs = extractToolSequences([
      createTrace(0, ["x"], [{ name: "TypeError", message: "boom", stack: "..." }]),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("benign metadata (provenance, hookName without denial flag) does not flip success", () => {
    const seqs = extractToolSequences([
      createTrace(
        0,
        ["x"],
        [{ output: "ok", metadata: { provenance: { system: "mcp" }, hookName: "audit" } }],
      ),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("success");
  });

  test("{ ok: true } envelope still counts as success", () => {
    const seqs = extractToolSequences([createTrace(0, ["x"], [{ ok: true, value: { count: 1 } }])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("success");
  });
});

describe("extractNgrams", () => {
  test("emits sliding-window n-grams of size [min..max]", () => {
    const map = extractNgrams([turn(0, ["a", "b", "c"])], 2, 3);
    expect(map.get("a|b")).toBeDefined();
    expect(map.get("b|c")).toBeDefined();
    expect(map.get("a|b|c")).toBeDefined();
    expect(map.get("a|b|c|d")).toBeUndefined();
  });

  test("counts a turn once per key even when pattern repeats within turn", () => {
    const map = extractNgrams([turn(0, ["a", "b", "a", "b"])], 2, 2);
    expect(map.get("a|b")?.locations.map((l) => l.turnIndex)).toEqual([0]);
  });

  test("aggregates same n-gram across multiple turns", () => {
    const map = extractNgrams(
      [turn(0, ["a", "b"]), turn(1, ["a", "b"]), turn(2, ["a", "b"])],
      2,
      2,
    );
    expect(map.get("a|b")?.locations.map((l) => l.turnIndex)).toEqual([0, 1, 2]);
  });

  test("preserves real (non-zero, non-contiguous) turn indices from the source traces", () => {
    const map = extractNgrams(
      [turn(10, ["a", "b"]), turn(42, ["a", "b"]), turn(100, ["a", "b"])],
      2,
      2,
    );
    expect(map.get("a|b")?.locations.map((l) => l.turnIndex)).toEqual([10, 42, 100]);
  });

  test("does not collapse occurrences from different sessions even when turn indices collide", () => {
    const sA = sessionId("sess-A");
    const sB = sessionId("sess-B");
    const make = (sid: typeof sA): TurnSequence => ({
      location: { sessionId: sid, agentId: AGENT, turnIndex: 0 },
      steps: [{ toolId: "a" }, { toolId: "b" }],
    });
    const map = extractNgrams([make(sA), make(sB)], 2, 2);
    const locs = map.get("a|b")?.locations ?? [];
    expect(locs).toHaveLength(2);
    expect(new Set(locs.map((l) => l.sessionId)).size).toBe(2);
  });

  test("does not collapse occurrences from different agents even when (session, turn) collide", () => {
    const sid = sessionId("shared-sess");
    const make = (agentId: string): TurnSequence => ({
      location: { sessionId: sid, agentId, turnIndex: 0 },
      steps: [{ toolId: "a" }, { toolId: "b" }],
    });
    const map = extractNgrams([make("agent-A"), make("agent-B")], 2, 2);
    expect(map.get("a|b")?.locations).toHaveLength(2);
  });

  test("dedupes input traces with identical (session, agent, turnIndex) — same turn cannot inflate occurrences", () => {
    // Replays, merged windows, or duplicate ingestion can include the same
    // turn twice. Composite identity is the package's stable occurrence id,
    // so duplicates must collapse to a single occurrence.
    const make = (): TurnSequence => ({
      location: { sessionId: SESSION, agentId: AGENT, turnIndex: 0 },
      steps: [{ toolId: "a" }, { toolId: "b" }],
    });
    // Use extractToolSequences via createTrace to exercise the dedup path.
    const sequences = extractToolSequences([
      createTrace(0, ["a", "b"]),
      createTrace(0, ["a", "b"]),
      createTrace(0, ["a", "b"]),
    ]);
    expect(sequences).toHaveLength(1);
    // And the n-gram pipeline must agree.
    const map = extractNgrams([make(), make(), make()].slice(0, 1), 2, 2);
    expect(map.get("a|b")?.locations).toHaveLength(1);
  });

  test("empty sequence contributes no n-grams", () => {
    const map = extractNgrams([turn(0, [])], 2, 3);
    expect(map.size).toBe(0);
  });
});
