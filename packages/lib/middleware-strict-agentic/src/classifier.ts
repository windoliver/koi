/**
 * Pure classifier for strict-agentic. Zero side effects.
 *
 * Evaluates in this order:
 *   1. toolCallCount > 0       → action
 *   2. blank output (no tools) → filler  (degraded / silent-failure guard)
 *   3. isFillerOutput(output)  → filler  (catches plan-language bypass
 *                                         including "I will X?" because
 *                                         filler runs BEFORE user-question)
 *   4. isUserQuestion(output)  → user-question
 *   5. isExplicitDone(output)  → explicit-done
 *   6. otherwise               → action
 *
 * Only `filler` is blocking. A plain substantive final answer like "10" or
 * "Updated 3 files" falls through to `action`. Empty / whitespace-only
 * completions with no tool calls are treated as degraded and blocked.
 *
 * Terse approval prompts like "Proceed?", "Approve?", "Use production DB?"
 * are passed by the default `isUserQuestion` (trailing `?`) because they
 * are the model legitimately asking the user for input. Plan-language
 * bypass attempts like "I will proceed?" are still blocked — isFillerOutput
 * runs first.
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
  if (config.isExplicitDone(facts.outputText)) return { kind: "explicit-done" };
  return { kind: "action" };
}
