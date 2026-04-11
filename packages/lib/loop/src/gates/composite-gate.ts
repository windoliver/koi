/**
 * createCompositeGate — runs sub-gates in order, stops at the first failure.
 *
 * This is the replacement for "shell operators" in verifier commands. Instead
 * of `bun typecheck && bun test`, users compose:
 *
 *   createCompositeGate([
 *     createArgvGate(["bun", "run", "typecheck"]),
 *     createArgvGate(["bun", "test"]),
 *   ])
 *
 * Semantics: all-pass for ok. First failure short-circuits and is returned
 * verbatim (including its typed reason). Aggregated details from passing
 * gates are concatenated into the final ok's details for observability.
 */

import type { Verifier, VerifierResult } from "../types.js";

export function createCompositeGate(gates: readonly Verifier[]): Verifier {
  if (gates.length === 0) {
    throw new Error("createCompositeGate: at least one gate is required");
  }
  return {
    async check(ctx): Promise<VerifierResult> {
      const passedDetails: string[] = [];
      for (const gate of gates) {
        if (ctx.signal.aborted) {
          return {
            ok: false,
            reason: "aborted",
            details: "composite gate aborted by external signal",
          };
        }
        const result = await gate.check(ctx);
        if (!result.ok) {
          // Short-circuit: return the first failure as-is.
          return result;
        }
        if (result.details !== undefined && result.details.length > 0) {
          passedDetails.push(result.details);
        }
      }
      return passedDetails.length > 0
        ? { ok: true, details: passedDetails.join("; ") }
        : { ok: true };
    },
  };
}
