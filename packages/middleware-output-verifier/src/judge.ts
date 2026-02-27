/**
 * Inlined LLM-as-judge helpers.
 *
 * Duplicates ~30 lines from @koi/eval/src/graders/llm-judge.ts intentionally.
 * Rule of Three: only 2 consumers exist. Extract to @koi/llm-judge-util at 3rd.
 */

export interface JudgeResult {
  readonly score: number;
  readonly reasoning: string;
  readonly parseError?: string | undefined;
}

/** Build the judge prompt from a rubric and model output content. */
export function buildJudgePrompt(rubric: string, content: string): string {
  return [
    "You are an output quality judge. Evaluate the following agent output.",
    "",
    "## Rubric",
    rubric,
    "",
    "## Agent Output",
    content,
    "",
    "## Instructions",
    'Respond with ONLY a JSON object: {"score": <0.0-1.0>, "reasoning": "<explanation>"}',
    "The score must be between 0.0 (worst) and 1.0 (best).",
  ].join("\n");
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
      const score = typeof parsed.score === "number" ? clampScore(parsed.score) : 0;
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

export function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}
