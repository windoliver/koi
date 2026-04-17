/**
 * Pure classifier for strict-agentic. Zero side effects.
 *
 * Short-circuits in this order:
 *   1. toolCallCount > 0       → action
 *   2. isUserQuestion(output)  → user-question
 *   3. isExplicitDone(output)  → explicit-done
 *   4. otherwise               → filler
 *
 * Only `filler` is blocking; everything else allows the turn to complete.
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
  config: Pick<ResolvedStrictAgenticConfig, "isUserQuestion" | "isExplicitDone">,
): ClassificationResult {
  if (facts.toolCallCount > 0) return { kind: "action" };
  if (config.isUserQuestion(facts.outputText)) return { kind: "user-question" };
  if (config.isExplicitDone(facts.outputText)) return { kind: "explicit-done" };
  return { kind: "filler" };
}
