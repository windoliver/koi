/**
 * Transcript assertions — flat functions that throw plain `Error` on failure.
 *
 * Runner-agnostic: compatible with bun:test, Vitest, Jest, and bare Node
 * because any thrown error causes a test failure.
 */

import type { EngineEvent } from "@koi/core";
import { collectOutput, collectText, collectToolNames, filterByKind } from "./collect.js";

export type ToolSequenceMode = "exact" | "contains" | "startsWith";

export function assertToolSequence(
  events: readonly EngineEvent[],
  expected: readonly string[],
  opts?: { readonly mode?: ToolSequenceMode },
): void {
  const actual = collectToolNames(events);
  const mode: ToolSequenceMode = opts?.mode ?? "exact";

  switch (mode) {
    case "exact": {
      if (actual.length !== expected.length || !actual.every((n, i) => n === expected[i])) {
        throw new Error(
          `assertToolSequence(exact): expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
        );
      }
      return;
    }
    case "startsWith": {
      if (actual.length < expected.length) {
        throw new Error(
          `assertToolSequence(startsWith): expected at least ${expected.length} tool calls, got ${actual.length} [${actual.join(", ")}]`,
        );
      }
      for (let i = 0; i < expected.length; i += 1) {
        if (actual[i] !== expected[i]) {
          throw new Error(
            `assertToolSequence(startsWith): mismatch at index ${i} — expected ${expected[i]}, got ${actual[i]}`,
          );
        }
      }
      return;
    }
    case "contains": {
      // Check expected appears as a contiguous subsequence in actual
      if (expected.length === 0) return;
      for (let start = 0; start <= actual.length - expected.length; start += 1) {
        let ok = true;
        for (let j = 0; j < expected.length; j += 1) {
          if (actual[start + j] !== expected[j]) {
            ok = false;
            break;
          }
        }
        if (ok) return;
      }
      throw new Error(
        `assertToolSequence(contains): expected subsequence [${expected.join(", ")}] not found in [${actual.join(", ")}]`,
      );
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`assertToolSequence: unknown mode ${String(_exhaustive)}`);
    }
  }
}

/**
 * Assert that no tool_call_end event carries an error result.
 *
 * The `result` field is `unknown`, so we heuristically look for common error
 * shapes that Koi tools produce: `{ ok: false }` (Result<T, E>), `{ kind: "error" }`,
 * and `{ error: ... }`. Absence of any tool_call_end is NOT an error.
 */
interface MaybeErrorShape {
  readonly ok?: unknown;
  readonly kind?: unknown;
  readonly error?: unknown;
}

export function assertNoToolErrors(events: readonly EngineEvent[]): void {
  const ends = filterByKind(events, "tool_call_end");
  for (const end of ends) {
    const result = end.result;
    if (result !== null && typeof result === "object") {
      const obj = result as MaybeErrorShape;
      if (obj.ok === false) {
        throw new Error(
          `assertNoToolErrors: tool call ${String(end.callId)} returned ok=false (${JSON.stringify(obj.error)})`,
        );
      }
      if (obj.kind === "error") {
        throw new Error(
          `assertNoToolErrors: tool call ${String(end.callId)} returned kind=error (${JSON.stringify(obj)})`,
        );
      }
      if ("error" in obj && obj.error !== undefined && obj.error !== null) {
        throw new Error(
          `assertNoToolErrors: tool call ${String(end.callId)} returned error field (${JSON.stringify(obj.error)})`,
        );
      }
    }
  }
}

export function assertCostUnder(events: readonly EngineEvent[], maxUsd: number): void {
  const output = collectOutput(events);
  if (output === undefined) {
    throw new Error("assertCostUnder: no done event found in transcript — cannot evaluate cost");
  }
  const cost = output.metrics.costUsd;
  if (cost === undefined) {
    // No cost data ≠ violation. Pass.
    return;
  }
  if (cost >= maxUsd) {
    throw new Error(`assertCostUnder: expected cost < $${maxUsd}, got $${cost}`);
  }
}

export function assertTextContains(events: readonly EngineEvent[], substring: string): void {
  const text = collectText(events);
  if (!text.includes(substring)) {
    throw new Error(`assertTextContains: expected text to contain "${substring}", got "${text}"`);
  }
}

export function assertTextMatches(events: readonly EngineEvent[], pattern: RegExp): void {
  const text = collectText(events);
  if (!pattern.test(text)) {
    throw new Error(`assertTextMatches: expected text to match ${pattern}, got "${text}"`);
  }
}

export function assertTurnCount(events: readonly EngineEvent[], expected: number): void {
  const turnStarts = filterByKind(events, "turn_start");
  if (turnStarts.length !== expected) {
    throw new Error(`assertTurnCount: expected ${expected} turns, got ${turnStarts.length}`);
  }
}
