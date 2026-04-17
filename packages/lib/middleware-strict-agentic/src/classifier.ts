/**
 * Pure classifier for strict-agentic. Zero side effects.
 *
 * Evaluates in this order:
 *   1. toolCallCount > 0          → action
 *   2. blank output (no tools)    → filler  (degraded / silent-failure guard)
 *   3. isFillerOutput(output)     → filler
 *   4. isUserQuestion(output)     → user-question
 *   5. trailing `?` (not user-Q)  → filler  (rhetorical / self-directed)
 *   6. isExplicitDone(output)     → explicit-done
 *   7. otherwise                  → action
 *
 * Only `filler` is blocking. A plain substantive final answer like "10" or
 * "Updated 3 files" falls through to `action` and is allowed to complete.
 * Empty / whitespace-only completions with no tool calls are treated as a
 * degraded response and blocked. Any `?` ending that is not a user-directed
 * question is treated as self-directed/rhetorical planning and blocked too.
 */

import type { ResolvedStrictAgenticConfig } from "./config.js";

export interface TurnFacts {
  readonly toolCallCount: number;
  readonly outputText: string;
}

export type ClassificationKind = "filler" | "action" | "user-question" | "explicit-done";

export interface ClassificationResult {
  readonly kind: ClassificationKind;
}

export function classifyTurn(
  facts: TurnFacts,
  config: Pick<ResolvedStrictAgenticConfig, "isUserQuestion" | "isExplicitDone" | "isFillerOutput">,
): ClassificationResult {
  if (facts.toolCallCount > 0) return { kind: "action" };
  if (facts.outputText.trim().length === 0) return { kind: "filler" };
  if (config.isFillerOutput(facts.outputText)) return { kind: "filler" };
  if (config.isUserQuestion(facts.outputText)) return { kind: "user-question" };
  // Any `?` ending that did NOT satisfy isUserQuestion is self-directed /
  // rhetorical — e.g. "Run the migration now?" or "Need to inspect the
  // logs?". These are plan/suggestion text phrased as a question and must
  // still block, otherwise the gate fails open on a trivial trailing-?
  // bypass.
  if (facts.outputText.trimEnd().endsWith("?")) return { kind: "filler" };
  if (config.isExplicitDone(facts.outputText)) return { kind: "explicit-done" };
  return { kind: "action" };
}
