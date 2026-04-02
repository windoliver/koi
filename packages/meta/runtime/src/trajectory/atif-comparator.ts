/**
 * ATIF structural comparator — compares trajectory steps by structure,
 * ignoring volatile fields (timestamps, durationMs, traceCallId UUIDs).
 *
 * Used by golden query tests to verify that VCR replay produces the
 * same trajectory shape as live E2E runs.
 */

import type { RichTrajectoryStep } from "@koi/core";

/** Fields compared for structural equality. */
export interface StepShape {
  readonly kind: "model_call" | "tool_call";
  readonly identifier: string;
  readonly source: "agent" | "tool" | "user" | "system";
  readonly outcome: "success" | "failure" | "retry";
  readonly hasRequest: boolean;
  readonly hasResponse: boolean;
  readonly hasError: boolean;
  readonly hasMetrics: boolean;
}

/** Extract the structural shape of a trajectory step (ignores volatile fields). */
export function extractShape(step: RichTrajectoryStep): StepShape {
  return {
    kind: step.kind,
    identifier: step.identifier,
    source: step.source,
    outcome: step.outcome,
    hasRequest: step.request !== undefined,
    hasResponse: step.response !== undefined,
    hasError: step.error !== undefined,
    hasMetrics: step.metrics !== undefined,
  };
}

/** Diff result for a single step comparison. */
export interface StepDiff {
  readonly index: number;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * Compare expected shapes against actual trajectory steps.
 * Accepts pre-extracted StepShape[] (from golden snapshots) or RichTrajectoryStep[]
 * (extracts shapes on the fly).
 */
export function compareTrajectoryShapes(
  expected: readonly StepShape[],
  actual: readonly RichTrajectoryStep[],
): readonly StepDiff[] {
  const diffs: StepDiff[] = [];
  const actualShapes = actual.map(extractShape);

  if (expected.length !== actualShapes.length) {
    diffs.push({
      index: -1,
      field: "length",
      expected: expected.length,
      actual: actualShapes.length,
    });
    return diffs;
  }

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const act = actualShapes[i];
    if (exp === undefined || act === undefined) continue;

    for (const key of Object.keys(exp) as readonly (keyof StepShape)[]) {
      if (exp[key] !== act[key]) {
        diffs.push({
          index: i,
          field: key,
          expected: exp[key],
          actual: act[key],
        });
      }
    }
  }

  return diffs;
}

/** Format diffs as a human-readable string for test failure messages. */
export function formatDiffs(diffs: readonly StepDiff[]): string {
  if (diffs.length === 0) return "No differences";
  return diffs
    .map((d) =>
      d.index === -1
        ? `step count: expected ${String(d.expected)}, got ${String(d.actual)}`
        : `step[${d.index}].${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`,
    )
    .join("\n");
}
