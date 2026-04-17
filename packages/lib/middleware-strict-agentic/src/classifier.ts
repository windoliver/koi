/**
 * Pure classifier for strict-agentic. Zero side effects.
 *
 * Evaluates in this order:
 *   1. toolCallCount > 0        → action
 *   2. isUserQuestion(output)   → user-question
 *   3. isExplicitDone(output)   → explicit-done
 *   4. isFillerOutput(output)   → filler
 *   5. otherwise                → action
 *
 * Only `filler` is blocking. A plain final answer like "10" or "Updated
 * 3 files" falls through to `action` and is allowed to complete — the
 * classifier blocks only on affirmative planning/filler signals, never by
 * default, so concise real completions are not spuriously re-prompted.
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
  if (config.isExplicitDone(facts.outputText)) return { kind: "explicit-done" };
  if (config.isFillerOutput(facts.outputText)) return { kind: "filler" };
  return { kind: "action" };
}
