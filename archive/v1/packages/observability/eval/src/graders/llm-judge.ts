/**
 * LLM-as-judge grader — uses a model call to evaluate agent output.
 */

import type { EngineEvent, EngineMetrics } from "@koi/core";
import { extractText, lastNTurns, summarizeTranscript } from "../transcript.js";
import type { EvalExpectation, EvalGrader, EvalScore, LlmJudgeConfig } from "../types.js";

const DEFAULT_LAST_N = 5;

export function createLlmJudgeGrader(config: LlmJudgeConfig): EvalGrader {
  const transcriptMode = config.transcriptMode ?? "full";
  const lastN = config.lastN ?? DEFAULT_LAST_N;

  return {
    id: "llm-judge",
    name: "LLM Judge",
    async grade(
      transcript: readonly EngineEvent[],
      expected: EvalExpectation | undefined,
      _metrics: EngineMetrics,
    ): Promise<EvalScore> {
      const transcriptText = formatTranscript(transcript, transcriptMode, lastN);
      const expectedText =
        expected !== undefined && expected.kind === "text" ? String(expected.pattern) : undefined;

      const prompt = buildPrompt(config.rubric, transcriptText, expectedText);

      try {
        const response = await config.modelCall(prompt);
        return parseJudgeResponse(response, config.parseScore);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Unknown model call error";
        return {
          graderId: "llm-judge",
          score: 0,
          pass: false,
          reasoning: `LLM judge error: ${message}`,
        };
      }
    },
  };
}

function formatTranscript(events: readonly EngineEvent[], mode: string, lastN: number): string {
  switch (mode) {
    case "summary":
      return summarizeTranscript(events);
    case "last-n":
      return extractText(lastNTurns(events, lastN));
    default:
      return extractText(events);
  }
}

function buildPrompt(rubric: string, transcript: string, expected: string | undefined): string {
  const parts = [
    "You are an evaluation judge. Score the following agent output.",
    "",
    "## Rubric",
    rubric,
    "",
    "## Agent Output",
    transcript,
  ];

  if (expected !== undefined) {
    parts.push("", "## Expected Output", expected);
  }

  parts.push(
    "",
    "## Instructions",
    'Respond with ONLY a JSON object: {"score": <0.0-1.0>, "reasoning": "<explanation>"}',
    "The score must be between 0.0 (worst) and 1.0 (best).",
  );

  return parts.join("\n");
}

function parseJudgeResponse(
  response: string,
  customParser?: (response: string) => number,
): EvalScore {
  if (customParser !== undefined) {
    const score = customParser(response);
    return {
      graderId: "llm-judge",
      score: clampScore(score),
      pass: score >= 0.5,
      reasoning: response,
    };
  }

  // Try JSON parse
  const jsonMatch = /\{[\s\S]*\}/.exec(response);
  if (jsonMatch?.[0] !== undefined) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Readonly<Record<string, unknown>>;
      const score = typeof parsed.score === "number" ? parsed.score : 0;
      const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : response;
      return {
        graderId: "llm-judge",
        score: clampScore(score),
        pass: score >= 0.5,
        reasoning,
      };
    } catch {
      // Fall through to fallback
    }
  }

  return {
    graderId: "llm-judge",
    score: 0,
    pass: false,
    reasoning: `Failed to parse judge response: ${response.slice(0, 200)}`,
  };
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}
