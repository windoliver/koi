/**
 * Gate execution — sequential, pass/fail checkpoints with no retry.
 */

import type { TurnContext } from "@koi/core/middleware";
import type { ValidationError, Validator } from "./types.js";

/** Result from gate execution. */
export type GateResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly failedGate: string;
      readonly errors: readonly ValidationError[];
    };

/** Runs all gates sequentially, collecting errors. Returns first failing gate's name. */
export async function runGates(
  output: unknown,
  gates: readonly Validator[],
  ctx: TurnContext,
): Promise<GateResult> {
  const allErrors: ValidationError[] = [];
  // let: tracks first failure name — set once, read later
  let firstFailedGate: string | undefined;

  for (const gate of gates) {
    try {
      const result = await gate.validate(output, ctx);
      if (!result.valid) {
        if (firstFailedGate === undefined) firstFailedGate = gate.name;
        allErrors.push(...result.errors);
      }
    } catch (e: unknown) {
      if (firstFailedGate === undefined) firstFailedGate = gate.name;
      allErrors.push({
        validator: gate.name,
        message: `Gate threw: ${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
      });
    }
  }

  if (firstFailedGate === undefined) {
    return { valid: true };
  }

  return { valid: false, failedGate: firstFailedGate, errors: allErrors };
}
