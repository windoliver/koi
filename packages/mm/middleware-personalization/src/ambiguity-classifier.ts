/**
 * Ambiguity classifier — detects when user instructions need clarification.
 */

import type { MemoryResult } from "@koi/core/ecs";

export interface AmbiguityAssessment {
  readonly ambiguous: boolean;
  readonly suggestedDirective?: string;
}

export interface AmbiguityClassifier {
  readonly classify: (
    instruction: string,
    relevantPreferences: readonly MemoryResult[],
  ) => AmbiguityAssessment | Promise<AmbiguityAssessment>;
}

const QUESTION_MARKERS: readonly string[] = ["should i", "which", "how should", "what kind"];

const ALTERNATIVE_MARKERS: readonly string[] = [" or ", "either", "between", "prefer"];

const DEFAULT_DIRECTIVE =
  "Before proceeding, ask the user about their preference for this task. Limit to one concise question with 2-4 specific options.";

export function createDefaultAmbiguityClassifier(): AmbiguityClassifier {
  return {
    classify(
      instruction: string,
      relevantPreferences: readonly MemoryResult[],
    ): AmbiguityAssessment {
      if (relevantPreferences.length > 0) {
        return { ambiguous: false };
      }

      if (instruction.length === 0) {
        return { ambiguous: false };
      }

      const lower = instruction.toLowerCase();

      const hasQuestion = QUESTION_MARKERS.some((m) => lower.includes(m));
      const hasAlternative = ALTERNATIVE_MARKERS.some((m) => lower.includes(m));

      if (hasQuestion && hasAlternative) {
        return { ambiguous: true, suggestedDirective: DEFAULT_DIRECTIVE };
      }

      return { ambiguous: false };
    },
  };
}
