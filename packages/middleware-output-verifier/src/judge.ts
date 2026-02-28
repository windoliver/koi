/**
 * Inlined LLM-as-judge helpers.
 *
 * Duplicates ~30 lines from @koi/eval/src/graders/llm-judge.ts intentionally.
 * Rule of Three: only 2 consumers exist. Extract to @koi/llm-judge-util at 3rd.
 */

const DEFAULT_HEAD_RATIO = 0.6;

export interface JudgeResult {
  readonly score: number;
  readonly reasoning: string;
  readonly parseError?: string | undefined;
}

/**
 * Truncate content to fit within maxLength, preserving head and tail context.
 *
 * Split: 60% from the start, 40% from the end, with an elision marker.
 * Returns content unchanged if it fits within maxLength.
 */
export function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;

  const headLen = Math.floor(maxLength * DEFAULT_HEAD_RATIO);
  const tailLen = maxLength - headLen;
  const elided = content.length - maxLength;
  return `${content.slice(0, headLen)}\n[...truncated ${String(elided)} chars...]\n${content.slice(-tailLen)}`;
}

/** Build the judge prompt from a rubric and model output content. */
export function buildJudgePrompt(
  rubric: string,
  content: string,
  maxContentLength?: number,
): string {
  const truncated =
    maxContentLength !== undefined ? truncateContent(content, maxContentLength) : content;
  return [
    "You are an output quality judge. Evaluate the following agent output.",
    "",
    "## Rubric",
    rubric,
    "",
    "## Agent Output",
    truncated,
    "",
    "## Instructions",
    'Respond with ONLY a JSON object: {"score": <1-5>, "reasoning": "<explanation>"}',
    "",
    "Score rubric:",
    "  1 — Completely fails the rubric criteria",
    "  2 — Major deficiencies, mostly fails criteria",
    "  3 — Partially meets criteria, significant gaps",
    "  4 — Mostly meets criteria, minor issues",
    "  5 — Fully meets or exceeds all criteria",
  ].join("\n");
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Normalize a raw 1-5 integer score to the 0.0–1.0 range.
 *
 * Formula: (clamp(raw, 1, 5) - 1) / 4
 *   Score 1 → 0.00, Score 2 → 0.25, Score 3 → 0.50,
 *   Score 4 → 0.75, Score 5 → 1.00
 */
export function normalizeScore(raw: number): number {
  const clamped = Math.max(1, Math.min(5, Math.round(raw)));
  return (clamped - 1) / 4;
}

/**
 * Parse the judge model response into a score + reasoning.
 * On any parse failure, returns score=0 with a parseError field (fail-closed).
 */
export function parseJudgeResponse(response: string): JudgeResult {
  // Non-greedy match avoids spanning multiple JSON objects in the response
  const jsonMatch = /\{[\s\S]*?\}/.exec(response);
  if (jsonMatch?.[0] !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e: unknown) {
      return {
        score: 0,
        reasoning: "",
        parseError: `Failed to parse judge JSON: ${e instanceof Error ? e.message : "unknown"} — raw: ${response.slice(0, 200)}`,
      };
    }
    if (isRecord(parsed)) {
      const score = typeof parsed.score === "number" ? normalizeScore(parsed.score) : 0;
      const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : response;
      return { score, reasoning };
    }
  }
  return {
    score: 0,
    reasoning: "",
    parseError: `Failed to parse judge response: ${response.slice(0, 200)}`,
  };
}

/** @deprecated Use normalizeScore instead. Kept for backward compatibility. */
export function clampScore(score: number): number {
  return normalizeScore(score);
}
