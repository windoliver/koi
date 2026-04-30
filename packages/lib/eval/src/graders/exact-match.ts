import type { ContentBlock, EngineEvent } from "@koi/core";
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
      const matches =
        typeof pattern === "string"
          ? text.includes(pattern)
          : // Clone the regex so stateful flags (g/y) cannot leak `lastIndex`
            // across grade() calls — graders are reused across trials.
            new RegExp(pattern.source, pattern.flags).test(text);
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

/**
 * Collect candidate assistant text from a transcript using the same
 * fall-back order the runtime's output collector uses: streaming
 * text_delta events first; otherwise concatenate text content from the
 * terminal `done` event; otherwise fall back to stringified tool_result
 * outputs (a tool-only agent's "answer").
 */
function collectAssistantText(transcript: readonly EngineEvent[]): string {
  const deltas: string[] = [];
  for (const ev of transcript) {
    if (ev.kind === "text_delta") deltas.push(ev.delta);
  }
  if (deltas.length > 0) return deltas.join("");

  const doneText = collectFromDone(transcript);
  if (doneText.length > 0) return doneText;

  return collectFromToolResults(transcript);
}

function collectFromDone(transcript: readonly EngineEvent[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const ev = transcript[i];
    if (ev?.kind === "done") return contentBlocksToText(ev.output.content);
  }
  return "";
}

function contentBlocksToText(content: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.kind === "text") parts.push(block.text);
  }
  return parts.join("");
}

function collectFromToolResults(transcript: readonly EngineEvent[]): string {
  const parts: string[] = [];
  for (const ev of transcript) {
    if (ev.kind === "tool_result") parts.push(stringifyOutput(ev.output));
  }
  return parts.join("\n");
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function describe(pattern: string | RegExp): string {
  return typeof pattern === "string" ? JSON.stringify(pattern) : pattern.toString();
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
