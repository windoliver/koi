import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAuditLog } from "../audit.js";
import { createDedupeIndex } from "../dedupe.js";
import { createDistiller } from "../distiller.js";
import { createDistillationPolicy } from "../policy.js";
import { createStagingQueue } from "../staging.js";
import { createSkillStore } from "../store.js";
import type { DistillationTrace, DistillerLLM, SkillDraft, TraceTurn } from "../types.js";

// Path to recorded ATIF trajectories produced by the runtime golden harness.
// We treat them as a corpus of "real-looking" tool/agent interactions and run
// the full skill-distiller pipeline over each one. The goal is breakage
// detection (no throws, every Result is honored), not output assertions —
// trajectories were not designed to be distilled, and many will fail
// grounding for legitimate reasons.
const FIXTURE_DIR = join(import.meta.dir, "..", "..", "..", "..", "meta", "runtime", "fixtures");

interface ATIFStep {
  readonly step_id: number;
  readonly source: "system" | "agent" | "tool" | "policy";
  readonly message?: string;
  readonly tool_calls?: ReadonlyArray<{
    readonly tool_call_id?: string;
    readonly function_name?: string;
    readonly arguments?: unknown;
  }>;
}

interface ATIFDoc {
  readonly schema_version: string;
  readonly session_id: string;
  readonly steps: readonly ATIFStep[];
}

function trajectoryToTrace(doc: ATIFDoc): DistillationTrace {
  const turns: TraceTurn[] = [];
  for (const step of doc.steps) {
    if (step.source === "agent" && step.message !== undefined) {
      // Alternate user/assistant heuristically — first agent step looks like
      // a user prompt; we don't try to be exact.
      const role = turns.length === 0 ? "user" : "assistant";
      turns.push({ role, text: step.message.slice(0, 1000) });
    } else if (step.source === "tool" && Array.isArray(step.tool_calls)) {
      const toolCalls = step.tool_calls
        .filter((c) => typeof c.function_name === "string")
        .map((c) => ({
          name: c.function_name as string,
          argsJson: JSON.stringify(c.arguments ?? {}),
        }));
      if (toolCalls.length > 0) turns.push({ role: "assistant", toolCalls });
    }
  }
  if (turns.length === 0) turns.push({ role: "user", text: "(empty trajectory)" });
  return { traceId: doc.session_id, sessionId: doc.session_id, turns };
}

// Plausible draft for a procedure — never executed, only used to drive the
// pipeline so we can observe whether grounding accepts/rejects with a
// well-typed error rather than throwing.
function draftFor(trace: DistillationTrace): SkillDraft {
  const tools = trace.turns
    .flatMap((t) => t.toolCalls ?? [])
    .map((c) => c.name)
    .slice(0, 16);
  return {
    name: "harness-skill",
    description: "Harness-synthesized skill for cassette-driven testing.",
    triggers: ["harness"],
    parameters: [
      { name: "input", description: "any input", required: true },
      { name: "target", description: "any target", required: false },
    ],
    toolSequence: tools,
    expectedInputs: ["harness input"],
    expectedOutputs: ["harness output"],
  };
}

function loadTrajectories(): readonly { name: string; doc: ATIFDoc }[] {
  let names: readonly string[];
  try {
    names = readdirSync(FIXTURE_DIR);
  } catch {
    return [];
  }
  const out: { name: string; doc: ATIFDoc }[] = [];
  for (const file of names) {
    if (!file.endsWith(".trajectory.json")) continue;
    const raw = readFileSync(join(FIXTURE_DIR, file), "utf8");
    out.push({ name: file, doc: JSON.parse(raw) as ATIFDoc });
  }
  return out;
}

const TRAJECTORIES = loadTrajectories();

describe("cassette-driven harness — no throws on real ATIF trajectories", () => {
  test("loaded at least one trajectory fixture", () => {
    expect(TRAJECTORIES.length).toBeGreaterThan(0);
  });

  for (const { name, doc } of TRAJECTORIES) {
    test(`pipeline survives ${name}`, async () => {
      const trace = trajectoryToTrace(doc);
      const draft = draftFor(trace);
      const llm: DistillerLLM = async () => ({ ok: true, value: JSON.stringify(draft) });
      const distiller = createDistiller({ allowUnredactedTrace: true, llm });
      const result = await distiller.distill(trace);
      // Must always produce a Result (never throw, never reject).
      expect(typeof result.ok).toBe("boolean");
      if (result.ok) {
        const audit = createAuditLog();
        const dedupe = createDedupeIndex();
        const store = createSkillStore({ maxSize: 8 });
        const staging = createStagingQueue();
        audit.record(result.value);
        const dedupeStatus = dedupe.register(result.value);
        expect(["new", "duplicate"]).toContain(dedupeStatus);
        const addStatus = store.add(result.value);
        expect(["added", "duplicate", "replaced", "conflict"]).toContain(addStatus);
        const staged = staging.stage(result.value);
        expect(staged.id).toBe(result.value.draftHash);
        const approved = staging.approve(staged.id);
        expect(approved?.status).toBe("approved");
      } else {
        // Errors must be well-formed validation/external — never undefined kind.
        expect(typeof result.error.context?.errorKind).toBe("string");
      }
    });
  }
});

describe("cassette harness — policy gate is total", () => {
  test("shouldDistill returns boolean and explain returns string for every trajectory", () => {
    const policy = createDistillationPolicy({ minTurns: 2, minToolCalls: 1 });
    for (const { doc } of TRAJECTORIES) {
      const trace = trajectoryToTrace(doc);
      const toolCount = trace.turns.reduce((n, t) => n + (t.toolCalls?.length ?? 0), 0);
      const outcome = {
        traceId: trace.traceId,
        verdict: "verified" as const,
        turnCount: trace.turns.length,
        toolCallCount: toolCount,
      };
      expect(typeof policy.shouldDistill(outcome)).toBe("boolean");
      expect(typeof policy.explain(outcome)).toBe("string");
    }
  });
});
