/**
 * Table-driven tests for the pure state machine. These run before any I/O
 * code exists — if the transition table is wrong, the loop will be wrong
 * regardless of how clean the orchestration is.
 */

import { describe, expect, test } from "bun:test";
import { type LoopPhase, nextTransition, type TransitionInput } from "./state-machine.js";
import type { VerifierResult } from "./types.js";

const pass: VerifierResult = { ok: true };
const fail = (reason: "exit_nonzero" | "timeout" = "exit_nonzero"): VerifierResult => ({
  ok: false,
  reason,
  details: "boom",
});

function base(overrides: Partial<TransitionInput> = {}): TransitionInput {
  return {
    phase: "verifying",
    iteration: 1,
    consecutiveFailures: 0,
    tokensConsumed: "unmetered",
    config: {
      maxIterations: 10,
      maxBudgetTokens: "unmetered",
      maxConsecutiveFailures: 3,
    },
    verifierResult: pass,
    runtimeError: undefined,
    aborted: false,
    ...overrides,
  };
}

describe("nextTransition", () => {
  describe("convergence", () => {
    test("verifier ok → converged", () => {
      const t = nextTransition(base({ verifierResult: pass }));
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      expect(t.status).toBe("converged");
    });

    test("converged iteration 1", () => {
      const t = nextTransition(base({ iteration: 1, verifierResult: pass }));
      expect(t.kind).toBe("terminal");
    });

    test("converged iteration N with prior failures does not trip breaker", () => {
      const t = nextTransition(
        base({ iteration: 5, consecutiveFailures: 2, verifierResult: pass }),
      );
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      expect(t.status).toBe("converged");
    });
  });

  describe("abort", () => {
    test("aborted flag → aborted terminal regardless of verifier", () => {
      const t = nextTransition(base({ aborted: true, verifierResult: pass }));
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      expect(t.status).toBe("aborted");
    });

    test("aborted takes precedence over errored runtime", () => {
      const t = nextTransition(
        base({ aborted: true, phase: "iterating", runtimeError: "no done event" }),
      );
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      expect(t.status).toBe("aborted");
    });
  });

  describe("errored runtime", () => {
    test("runtime error during iterating → errored terminal, verifier skipped", () => {
      const t = nextTransition(
        base({
          phase: "iterating",
          runtimeError: "zero events",
          verifierResult: undefined,
        }),
      );
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      expect(t.status).toBe("errored");
      expect(t.reason).toContain("zero events");
    });
  });

  describe("circuit breaker", () => {
    test("failure under threshold → continue to next iteration", () => {
      // pre-state 1 failure + this one = 2, under default threshold of 3
      const t = nextTransition(base({ consecutiveFailures: 1, verifierResult: fail() }));
      expect(t.kind).toBe("continue");
      if (t.kind !== "continue") throw new Error("unreachable");
      expect(t.nextIteration).toBe(2);
      expect(t.nextConsecutiveFailures).toBe(2);
    });

    test("failure reaching threshold → circuit_broken", () => {
      // pre-state: 2 consecutive failures, this is the 3rd
      const t = nextTransition(
        base({
          iteration: 3,
          consecutiveFailures: 2,
          verifierResult: fail(),
          config: {
            maxIterations: 10,
            maxBudgetTokens: "unmetered",
            maxConsecutiveFailures: 3,
          },
        }),
      );
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      expect(t.status).toBe("circuit_broken");
    });

    test("breaker is a pure counter — no text comparison", () => {
      // 3 failures with *different* messages must still trip
      const t = nextTransition(
        base({
          iteration: 3,
          consecutiveFailures: 2,
          verifierResult: { ok: false, reason: "exit_nonzero", details: "completely different" },
          config: {
            maxIterations: 10,
            maxBudgetTokens: "unmetered",
            maxConsecutiveFailures: 3,
          },
        }),
      );
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      expect(t.status).toBe("circuit_broken");
    });
  });

  describe("iteration budget", () => {
    test("failure at iteration < max → continue", () => {
      const t = nextTransition(
        base({
          iteration: 5,
          verifierResult: fail(),
          config: { maxIterations: 10, maxBudgetTokens: "unmetered", maxConsecutiveFailures: 3 },
        }),
      );
      expect(t.kind).toBe("continue");
    });

    test("failure at iteration == max → exhausted", () => {
      const t = nextTransition(
        base({
          iteration: 10,
          verifierResult: fail(),
          config: { maxIterations: 10, maxBudgetTokens: "unmetered", maxConsecutiveFailures: 3 },
        }),
      );
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      expect(t.status).toBe("exhausted");
      expect(t.reason).toContain("maxIterations");
    });

    test("exhaustion takes precedence over circuit breaker when both fire", () => {
      // consecutiveFailures reaching threshold AND iteration at cap.
      // We choose: circuit_broken fires first because it's a stronger signal
      // ("the agent is stuck") than "ran out of tries".
      const t = nextTransition(
        base({
          iteration: 10,
          consecutiveFailures: 2,
          verifierResult: fail(),
          config: { maxIterations: 10, maxBudgetTokens: "unmetered", maxConsecutiveFailures: 3 },
        }),
      );
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      // Contract: circuit_broken wins
      expect(t.status).toBe("circuit_broken");
    });
  });

  describe("token budget", () => {
    test("unmetered mode never exhausts by budget", () => {
      const t = nextTransition(
        base({
          iteration: 2,
          tokensConsumed: 999_999,
          verifierResult: fail(),
          config: { maxIterations: 10, maxBudgetTokens: "unmetered", maxConsecutiveFailures: 3 },
        }),
      );
      expect(t.kind).toBe("continue");
    });

    test("metered mode exhausts when consumed >= cap", () => {
      const t = nextTransition(
        base({
          iteration: 2,
          tokensConsumed: 1000,
          verifierResult: fail(),
          config: { maxIterations: 10, maxBudgetTokens: 1000, maxConsecutiveFailures: 3 },
        }),
      );
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      expect(t.status).toBe("exhausted");
      expect(t.reason).toContain("maxBudgetTokens");
    });

    test("regression: over-budget iteration with passing verifier → exhausted, NOT converged", () => {
      // Hard-cap semantics: if an iteration blows past maxBudgetTokens,
      // the budget violation wins even when the verifier passed. The user
      // set a spend ceiling; we respect it even if the goal was met on
      // the same turn.
      const t = nextTransition(
        base({
          iteration: 1,
          tokensConsumed: 10_000,
          verifierResult: pass,
          config: { maxIterations: 10, maxBudgetTokens: 1_000, maxConsecutiveFailures: 3 },
        }),
      );
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      expect(t.status).toBe("exhausted");
      expect(t.reason).toContain("maxBudgetTokens");
    });

    test("passing verifier under budget still converges", () => {
      const t = nextTransition(
        base({
          iteration: 1,
          tokensConsumed: 500,
          verifierResult: pass,
          config: { maxIterations: 10, maxBudgetTokens: 1_000, maxConsecutiveFailures: 3 },
        }),
      );
      expect(t.kind).toBe("terminal");
      if (t.kind !== "terminal") throw new Error("unreachable");
      expect(t.status).toBe("converged");
    });

    test("metered mode under cap → continue", () => {
      const t = nextTransition(
        base({
          iteration: 2,
          tokensConsumed: 500,
          verifierResult: fail(),
          config: { maxIterations: 10, maxBudgetTokens: 1000, maxConsecutiveFailures: 3 },
        }),
      );
      expect(t.kind).toBe("continue");
    });

    test("unmetered tokensConsumed with metered cap → treat as 0, continue", () => {
      // Adapter didn't report usage this iteration but a cap is set.
      // We don't flip to exhausted on an unknown — the warning path handles
      // the "cap set but nothing reported" case.
      const t = nextTransition(
        base({
          iteration: 2,
          tokensConsumed: "unmetered",
          verifierResult: fail(),
          config: { maxIterations: 10, maxBudgetTokens: 1000, maxConsecutiveFailures: 3 },
        }),
      );
      expect(t.kind).toBe("continue");
    });
  });

  describe("invalid inputs", () => {
    test("verifying phase without verifierResult throws", () => {
      expect(() =>
        nextTransition(base({ phase: "verifying", verifierResult: undefined })),
      ).toThrow();
    });
  });
});

// Reference the type to keep tsc honest about exports.
const _phases: readonly LoopPhase[] = ["iterating", "verifying"];
void _phases;
