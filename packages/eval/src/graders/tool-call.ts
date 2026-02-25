/**
 * Tool call grader — scores based on expected vs actual tool usage.
 */

import type { EngineEvent, EngineMetrics } from "@koi/core";
import { extractToolCalls } from "../transcript.js";
import type { EvalExpectation, EvalGrader, EvalScore } from "../types.js";

export interface ToolCallGraderConfig {
  /** Whether tool calls must appear in expected order. Default: false. */
  readonly orderStrict?: boolean;
}

export function createToolCallGrader(config?: ToolCallGraderConfig): EvalGrader {
  const orderStrict = config?.orderStrict ?? false;

  return {
    id: "tool-call",
    name: "Tool Call",
    grade(
      transcript: readonly EngineEvent[],
      expected: EvalExpectation | undefined,
      _metrics: EngineMetrics,
    ): EvalScore {
      if (expected === undefined || expected.kind !== "tool_calls") {
        return {
          graderId: "tool-call",
          score: 0,
          pass: false,
          reasoning: "No tool_calls expectation provided",
        };
      }

      const actualCalls = extractToolCalls(transcript);
      const expectedCalls = expected.calls;

      if (expectedCalls.length === 0 && actualCalls.length === 0) {
        return {
          graderId: "tool-call",
          score: 1,
          pass: true,
          reasoning: "No tool calls expected or observed",
        };
      }

      if (expectedCalls.length === 0) {
        return {
          graderId: "tool-call",
          score: 0,
          pass: false,
          reasoning: `Expected no tool calls but got ${String(actualCalls.length)}`,
        };
      }

      const actualNames = actualCalls.map((c) => c.toolName);
      const expectedNames = expectedCalls.map((c) => c.toolName);

      if (orderStrict || expectedCalls.some((c) => c.order === "strict")) {
        return gradeStrictOrder(expectedNames, actualNames, expectedCalls, actualCalls);
      }

      return gradeAnyOrder(expectedNames, actualNames, expectedCalls, actualCalls);
    },
  };
}

function gradeStrictOrder(
  expectedNames: readonly string[],
  actualNames: readonly string[],
  expectedCalls: readonly {
    readonly toolName: string;
    readonly args?: Readonly<Record<string, unknown>>;
  }[],
  actualCalls: readonly {
    readonly toolName: string;
    readonly args?: Readonly<Record<string, unknown>>;
  }[],
): EvalScore {
  // let justified: tracking matched count for score calculation
  let matched = 0;
  // let justified: tracking position in actual calls for sequential matching
  let actualIdx = 0;

  for (const exp of expectedCalls) {
    while (actualIdx < actualCalls.length) {
      const actual = actualCalls[actualIdx];
      actualIdx += 1;
      if (actual !== undefined && actual.toolName === exp.toolName) {
        if (exp.args === undefined || argsMatch(exp.args, actual.args)) {
          matched += 1;
        }
        break;
      }
    }
  }

  const total = Math.max(expectedNames.length, actualNames.length);
  const score = total > 0 ? matched / total : 1;

  return {
    graderId: "tool-call",
    score,
    pass: score >= 0.5,
    reasoning: `Strict order: ${String(matched)}/${String(expectedCalls.length)} expected calls matched`,
  };
}

function gradeAnyOrder(
  expectedNames: readonly string[],
  actualNames: readonly string[],
  expectedCalls: readonly {
    readonly toolName: string;
    readonly args?: Readonly<Record<string, unknown>>;
  }[],
  actualCalls: readonly {
    readonly toolName: string;
    readonly args?: Readonly<Record<string, unknown>>;
  }[],
): EvalScore {
  const expectedSet = new Set(expectedNames);
  const actualSet = new Set(actualNames);

  const intersection = [...expectedSet].filter((n) => actualSet.has(n)).length;
  const union = new Set([...expectedNames, ...actualNames]).size;
  const jaccardScore = union > 0 ? intersection / union : 1;

  // Also check args for matched tools
  // let justified: tracking arg-matching failures
  let argMismatches = 0;
  for (const exp of expectedCalls) {
    if (exp.args !== undefined) {
      const matching = actualCalls.find((a) => a.toolName === exp.toolName);
      if (matching !== undefined && !argsMatch(exp.args, matching.args)) {
        argMismatches += 1;
      }
    }
  }

  const argPenalty = expectedCalls.length > 0 ? argMismatches / expectedCalls.length : 0;
  const score = Math.max(0, jaccardScore - argPenalty * 0.5);

  return {
    graderId: "tool-call",
    score,
    pass: score >= 0.5,
    reasoning: `Any order: Jaccard=${jaccardScore.toFixed(2)}, arg mismatches=${String(argMismatches)}`,
  };
}

function argsMatch(
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (actual === undefined) return false;

  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      if (
        typeof value === "object" &&
        value !== null &&
        typeof actual[key] === "object" &&
        actual[key] !== null
      ) {
        if (JSON.stringify(value) !== JSON.stringify(actual[key])) {
          return false;
        }
      } else {
        return false;
      }
    }
  }
  return true;
}
