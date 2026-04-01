/**
 * Publish-time security gate — decides whether a brick may be registered.
 *
 * Scoring bands:
 *   score <  30 → BLOCKED  (brick rejected)
 *   score 30–49 → WARNING  (brick accepted with findings logged)
 *   score >= 50 → PASS     (brick accepted)
 */

import type { BrickArtifact } from "@koi/core";
import type { SecurityGate, SecurityGateResult } from "./types.js";

/** Score threshold below which a brick is blocked from publishing. */
const BLOCK_THRESHOLD = 30;

/** Score threshold below which a brick publishes with warnings. */
const WARN_THRESHOLD = 50;

export type SecurityVerdict = "blocked" | "warning" | "passed";

export interface SecurityDecision {
  readonly verdict: SecurityVerdict;
  readonly result: SecurityGateResult;
}

/**
 * Run the security gate on a brick and return a structured decision.
 *
 * If no gate is provided, the brick passes unconditionally.
 */
export async function evaluateSecurityGate(
  gate: SecurityGate | undefined,
  brick: BrickArtifact,
): Promise<SecurityDecision> {
  if (gate === undefined) {
    return {
      verdict: "passed",
      result: { passed: true, score: 100 },
    };
  }

  const result = await gate.check(brick);

  if (result.score < BLOCK_THRESHOLD) {
    return { verdict: "blocked", result };
  }
  if (result.score < WARN_THRESHOLD) {
    return { verdict: "warning", result };
  }
  return { verdict: "passed", result };
}
