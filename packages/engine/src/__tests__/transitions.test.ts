import { describe, expect, test } from "bun:test";
import type { AgentStatus, ProcessState, TransitionReason } from "@koi/core";
import { VALID_TRANSITIONS } from "@koi/core";
import type { TransitionInput } from "../transitions.js";
import { applyTransition, validateTransition } from "../transitions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function input(
  from: ProcessState,
  to: ProcessState,
  generation = 0,
  reason: TransitionReason = { kind: "assembly_complete" },
): TransitionInput {
  return { from, to, expectedGeneration: generation, reason };
}

// ---------------------------------------------------------------------------
// validateTransition
// ---------------------------------------------------------------------------

describe("validateTransition", () => {
  // --- Valid transitions (all edges from VALID_TRANSITIONS) ---

  test("created → running is valid", () => {
    const result = validateTransition("created", "running");
    expect(result.ok).toBe(true);
  });

  test("running → waiting is valid", () => {
    const result = validateTransition("running", "waiting");
    expect(result.ok).toBe(true);
  });

  test("running → suspended is valid", () => {
    const result = validateTransition("running", "suspended");
    expect(result.ok).toBe(true);
  });

  test("running → terminated is valid", () => {
    const result = validateTransition("running", "terminated");
    expect(result.ok).toBe(true);
  });

  test("waiting → running is valid", () => {
    const result = validateTransition("waiting", "running");
    expect(result.ok).toBe(true);
  });

  test("waiting → terminated is valid", () => {
    const result = validateTransition("waiting", "terminated");
    expect(result.ok).toBe(true);
  });

  test("suspended → running is valid", () => {
    const result = validateTransition("suspended", "running");
    expect(result.ok).toBe(true);
  });

  test("suspended → terminated is valid", () => {
    const result = validateTransition("suspended", "terminated");
    expect(result.ok).toBe(true);
  });

  // --- Invalid transitions ---

  test("terminated → running is invalid", () => {
    const result = validateTransition("terminated", "running");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("terminated");
      expect(result.error.message).toContain("running");
    }
  });

  test("terminated → created is invalid", () => {
    const result = validateTransition("terminated", "created");
    expect(result.ok).toBe(false);
  });

  test("created → suspended is invalid (must go through running first)", () => {
    const result = validateTransition("created", "suspended");
    expect(result.ok).toBe(false);
  });

  test("created → waiting is invalid", () => {
    const result = validateTransition("created", "waiting");
    expect(result.ok).toBe(false);
  });

  test("created → terminated is invalid (must go through running first)", () => {
    const result = validateTransition("created", "terminated");
    expect(result.ok).toBe(false);
  });

  test("self-transition is invalid", () => {
    const result = validateTransition("running", "running");
    expect(result.ok).toBe(false);
  });

  test("waiting → suspended is invalid", () => {
    const result = validateTransition("waiting", "suspended");
    expect(result.ok).toBe(false);
  });

  // --- Edge: verify all transitions in VALID_TRANSITIONS are accepted ---

  test("all valid transitions from architecture doc are accepted", () => {
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of targets) {
        const result = validateTransition(from as ProcessState, to);
        expect(result.ok).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// applyTransition
// ---------------------------------------------------------------------------

describe("applyTransition", () => {
  test("successful transition increments generation", () => {
    const result = applyTransition(
      { phase: "created", generation: 0, conditions: [], lastTransitionAt: 0 },
      input("created", "running", 0, { kind: "assembly_complete" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phase).toBe("running");
      expect(result.value.generation).toBe(1);
      expect(result.value.reason).toEqual({ kind: "assembly_complete" });
      expect(result.value.lastTransitionAt).toBeGreaterThan(0);
    }
  });

  test("preserves existing conditions", () => {
    const result = applyTransition(
      {
        phase: "running",
        generation: 3,
        conditions: ["Initialized", "Ready"],
        lastTransitionAt: 1000,
      },
      input("running", "waiting", 3, { kind: "awaiting_response" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.conditions).toEqual(["Initialized", "Ready"]);
    }
  });

  // --- CAS: generation mismatch → CONFLICT ---

  test("stale generation returns CONFLICT error", () => {
    const result = applyTransition(
      { phase: "running", generation: 5, conditions: [], lastTransitionAt: 0 },
      input("running", "waiting", 3), // expected 3 but current is 5
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("generation");
    }
  });

  test("future generation returns CONFLICT error", () => {
    const result = applyTransition(
      { phase: "running", generation: 2, conditions: [], lastTransitionAt: 0 },
      input("running", "waiting", 10), // expected 10 but current is 2
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  // --- CAS: phase mismatch → CONFLICT ---

  test("phase mismatch returns CONFLICT error", () => {
    const result = applyTransition(
      { phase: "suspended", generation: 3, conditions: [], lastTransitionAt: 0 },
      input("running", "waiting", 3), // expects running but agent is suspended
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
      expect(result.error.message).toContain("suspended");
      expect(result.error.message).toContain("running");
    }
  });

  // --- Invalid transition → VALIDATION ---

  test("invalid transition returns VALIDATION error", () => {
    const result = applyTransition(
      { phase: "created", generation: 0, conditions: [], lastTransitionAt: 0 },
      input("created", "terminated", 0),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  // --- Immutability: original status is not mutated ---

  test("original status object is not mutated", () => {
    const original = {
      phase: "created" as const,
      generation: 0,
      conditions: [] as const,
      lastTransitionAt: 0,
    };
    const originalCopy = { ...original };

    applyTransition(original, input("created", "running", 0, { kind: "assembly_complete" }));

    expect(original).toEqual(originalCopy);
  });

  // --- Multiple sequential transitions ---

  test("chained transitions increment generation correctly", () => {
    let status: AgentStatus = {
      phase: "created",
      generation: 0,
      conditions: [],
      lastTransitionAt: 0,
    };

    // created → running (gen 0 → 1)
    const r1 = applyTransition(
      status,
      input("created", "running", 0, { kind: "assembly_complete" }),
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) status = r1.value;

    // running → waiting (gen 1 → 2)
    const r2 = applyTransition(
      status,
      input("running", "waiting", 1, { kind: "awaiting_response" }),
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) status = r2.value;

    // waiting → running (gen 2 → 3)
    const r3 = applyTransition(
      status,
      input("waiting", "running", 2, { kind: "response_received" }),
    );
    expect(r3.ok).toBe(true);
    if (r3.ok) status = r3.value;

    expect(status.generation).toBe(3);
    expect(status.phase).toBe("running");
  });
});
