import type { ContentBlock, EngineEvent } from "@koi/core";
import type { EvalExpectation, EvalGrader, EvalScore } from "../types.js";

export interface ExactMatchOptions {
  readonly id?: string | undefined;
  readonly pattern?: string | RegExp | undefined;
  /**
   * When true, fall back to stringified `tool_result` outputs when no
   * assistant text was produced. Default false: a tool-only agent that
   * never surfaced its result as text would otherwise score as a pass.
   */
  readonly includeToolResults?: boolean | undefined;
}

const DEFAULT_ID = "exact-match";

export function exactMatch(options: ExactMatchOptions = {}): EvalGrader {
  const id = options.id ?? DEFAULT_ID;
  const fallback = options.pattern;
  const includeToolResults = options.includeToolResults ?? false;
  const configFingerprint = `pattern=${describePattern(fallback)};includeToolResults=${includeToolResults}`;
  return {
    id,
    configFingerprint,
    grade: (transcript, expected): EvalScore => {
      const pattern = resolvePattern(expected, fallback);
      if (pattern === undefined) {
        return { graderId: id, score: 0, pass: false, reasoning: "no text expectation provided" };
      }
      const text = collectAssistantText(transcript, includeToolResults);
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
 * Collect candidate assistant text. The terminal `done` event is the
 * authoritative final response — middleware (e.g. exfiltration guards)
 * may sanitize content between the streamed deltas and `done`, so we
 * grade against `done.output.content` whenever it is present. Streaming
 * `text_delta` is only the fallback when no `done` event exists.
 *
 * Tool-result fallback is opt-in: a tool-only agent that never surfaced
 * its result as text scores as a fail by default, since the user never
 * saw the answer.
 */
function collectAssistantText(
  transcript: readonly EngineEvent[],
  includeToolResults: boolean,
): string {
  const done = findDone(transcript);
  if (done !== undefined) {
    const doneText = contentBlocksToText(done.output.content);
    if (doneText.length > 0) return doneText;
    // Done with non-text content blocks (image/file/button/custom) is a
    // deliberate structured response — do NOT fall back to streamed
    // text_delta or raw tool_result. The agent showed the user something
    // structured; matching against backend data they never saw would be a
    // false positive (and falling back to deltas could leak pre-sanitized
    // text). Returning empty makes text-pattern grading fail with clear
    // reasoning, which is correct.
    if (done.output.content.length > 0) return "";
    // Done with truly empty content array — fall through to deltas, since
    // there is nothing structured to prefer over them.
  }

  const deltas: string[] = [];
  for (const ev of transcript) {
    if (ev.kind === "text_delta") deltas.push(ev.delta);
  }
  if (deltas.length > 0) return deltas.join("");

  return includeToolResults ? collectFromToolResults(transcript) : "";
}

function findDone(
  transcript: readonly EngineEvent[],
): Extract<EngineEvent, { kind: "done" }> | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const ev = transcript[i];
    if (ev?.kind === "done") return ev;
  }
  return undefined;
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

function describePattern(p: string | RegExp | undefined): string {
  if (p === undefined) return "none";
  if (typeof p === "string") return `s:${JSON.stringify(p)}`;
  return `r:${JSON.stringify(p.source)}/${JSON.stringify(p.flags)}`;
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
