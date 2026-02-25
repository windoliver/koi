/**
 * Exact match grader — scores against text expectations.
 */

import type { EngineEvent, EngineMetrics } from "@koi/core";
import { extractText } from "../transcript.js";
import type { EvalExpectation, EvalGrader, EvalScore } from "../types.js";

export interface ExactMatchConfig {
  readonly caseSensitive?: boolean;
}

export function createExactMatchGrader(config?: ExactMatchConfig): EvalGrader {
  const caseSensitive = config?.caseSensitive ?? true;

  return {
    id: "exact-match",
    name: "Exact Match",
    grade(
      transcript: readonly EngineEvent[],
      expected: EvalExpectation | undefined,
      _metrics: EngineMetrics,
    ): EvalScore {
      if (expected === undefined || expected.kind !== "text") {
        return {
          graderId: "exact-match",
          score: 0,
          pass: false,
          reasoning: "No text expectation provided",
        };
      }

      const output = extractText(transcript);
      const { pattern } = expected;

      const matches =
        pattern instanceof RegExp
          ? pattern.test(output)
          : caseSensitive
            ? output.includes(pattern)
            : output.toLowerCase().includes(pattern.toLowerCase());

      return {
        graderId: "exact-match",
        score: matches ? 1 : 0,
        pass: matches,
        reasoning: matches
          ? "Output matches expected pattern"
          : `Output did not match expected pattern`,
      };
    },
  };
}
