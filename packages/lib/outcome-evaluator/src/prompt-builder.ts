/**
 * Grader prompt construction — pure functions, no side effects.
 *
 * Single source of truth for the rubric → grader prompt transformation.
 * Used by both single-call mode and per-criterion isolated mode.
 */

import type { OutcomeRubric, RubricCriterion } from "@koi/core";

/** Expected JSON structure the grader must return. */
const RESPONSE_SCHEMA = `{
  "criteria": [
    { "name": "<criterion name>", "passed": true | false, "gap": "<what's missing (omit if passed)>" }
  ],
  "explanation": "<brief overall assessment>"
}`;

/**
 * Build a grader prompt for rubric evaluation.
 *
 * When `criterion` is provided, evaluates only that single criterion
 * (used in isolateCriteria mode to prevent halo effects).
 * When omitted, evaluates all criteria in one call.
 */
export function buildGraderPrompt(
  rubric: OutcomeRubric,
  artifact: string,
  criterion?: RubricCriterion,
): string {
  const criteriaToEvaluate = criterion !== undefined ? [criterion] : rubric.criteria;

  const criteriaList = criteriaToEvaluate
    .map((c) => `- **${c.name}**: ${c.description}`)
    .join("\n");

  return `You are a strict rubric evaluator. Evaluate the following artifact against the specified criteria.

## Task Description
${rubric.description}

## Criteria to Evaluate
${criteriaList}

## Artifact to Evaluate
<artifact>
${artifact}
</artifact>

## Instructions
- Evaluate ONLY the criteria listed above. Do not introduce new criteria.
- For each criterion: set "passed" to true only if the artifact clearly satisfies it.
- If "passed" is false, include a "gap" field describing specifically what is missing or incorrect.
- Be strict: partial satisfaction counts as failure.
- Your "explanation" should be a concise 1-3 sentence overall assessment.

## Required Response Format
Respond with ONLY valid JSON matching this exact schema (no markdown, no extra text):
${RESPONSE_SCHEMA}`;
}
