import type { EngineEvent } from "@koi/core";
import type { EvalExpectation, EvalGrader, EvalScore } from "../types.js";

export interface ExactMatchOptions {
  readonly id?: string | undefined;
  readonly pattern?: string | RegExp | undefined;
}

const DEFAULT_ID = "exact-match";

export function exactMatch(options: ExactMatchOptions = {}): EvalGrader {
  const id = options.id ?? DEFAULT_ID;
  const fallback = options.pattern;
  return {
    id,
    grade: (transcript, expected): EvalScore => {
      const pattern = resolvePattern(expected, fallback);
      if (pattern === undefined) {
        return { graderId: id, score: 0, pass: false, reasoning: "no text expectation provided" };
      }
      const text = collectAssistantText(transcript);
      const matches = typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
      return {
        graderId: id,
        score: matches ? 1 : 0,
        pass: matches,
        reasoning: matches ? "matched" : `expected ${describe(pattern)}, got ${truncate(text)}`,
      };
    },
  };
}

function resolvePattern(
  expected: EvalExpectation | undefined,
  fallback: string | RegExp | undefined,
): string | RegExp | undefined {
  if (expected !== undefined && expected.kind === "text") return expected.pattern;
  return fallback;
}

function collectAssistantText(transcript: readonly EngineEvent[]): string {
  const parts: string[] = [];
  for (const ev of transcript) {
    if (ev.kind === "text_delta") parts.push(ev.delta);
  }
  return parts.join("");
}

function describe(pattern: string | RegExp): string {
  return typeof pattern === "string" ? JSON.stringify(pattern) : pattern.toString();
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
