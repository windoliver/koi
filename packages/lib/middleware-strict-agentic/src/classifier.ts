/**
 * Pure classifier for strict-agentic. Zero side effects.
 *
 * Evaluates in this order:
 *   1. toolCallCount > 0        → action
 *   2. isUserQuestion(output)   → user-question
 *   3. blank output (no tools)  → filler  (degraded / silent-failure guard)
 *   4. isFillerOutput(output)   → filler  (evaluated BEFORE explicit-done so
 *                                          a model cannot bypass the gate by
 *                                          appending a completion keyword to
 *                                          an otherwise plan-only reply —
 *                                          e.g. "Here is my plan. Plan
 *                                          completed." must still block)
 *   5. isExplicitDone(output)   → explicit-done
 *   6. otherwise                → action
 *
 * Only `filler` is blocking. A plain substantive final answer like "10" or
 * "Updated 3 files" falls through to `action` and is allowed to complete.
 * Empty / whitespace-only completions with no tool calls are treated as a
 * degraded response and blocked, because they represent the model stopping
 * without having done anything (silent failure).
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
  if (config.isUserQuestion(facts.outputText)) return { kind: "user-question" };
  if (facts.outputText.trim().length === 0) return { kind: "filler" };
  if (config.isFillerOutput(facts.outputText)) return { kind: "filler" };
  if (config.isExplicitDone(facts.outputText)) return { kind: "explicit-done" };
  return { kind: "action" };
}
