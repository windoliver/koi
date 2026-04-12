/**
 * Parse raw grader model output into a structured OutcomeEvaluation.
 *
 * Fail-closed on any parse error: returns ok:false with a reason string.
 * Extra fields in the grader response are ignored (forward-compatible).
 */

import type { CriterionResult, OutcomeEvaluation, OutcomeRubric } from "@koi/core";

export type ParseResult =
  | { readonly ok: true; readonly value: OutcomeEvaluation }
  | { readonly ok: false; readonly raw: string; readonly reason: string };

/**
 * Parse the raw string returned by the grader model.
 *
 * @param raw       - Raw string from graderModelCall (may contain leading/trailing whitespace)
 * @param rubric    - The rubric the grader was evaluating against
 * @param iteration - 1-based iteration index for the OutcomeEvaluation record
 */
export function parseGraderResponse(
  raw: string,
  rubric: OutcomeRubric,
  iteration: number,
): ParseResult {
  if (raw === "" || raw === null || raw === undefined) {
    return { ok: false, raw: String(raw), reason: "grader returned empty response" };
  }

  // Strip optional markdown code fences the grader may have added
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, raw, reason: `JSON parse error: ${msg}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, raw, reason: "root value must be a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.criteria)) {
    return { ok: false, raw, reason: 'missing required field "criteria" (must be array)' };
  }

  const explanation = typeof obj.explanation === "string" ? obj.explanation : "";

  const criteriaResults: CriterionResult[] = [];
  for (const item of obj.criteria as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, raw, reason: "each criteria entry must be an object" };
    }
    const entry = item as Record<string, unknown>;

    if (typeof entry.name !== "string") {
      return { ok: false, raw, reason: 'criteria entry missing string field "name"' };
    }
    if (typeof entry.passed !== "boolean") {
      return {
        ok: false,
        raw,
        reason: `criteria entry "${entry.name}" has non-boolean "passed" (got ${typeof entry.passed})`,
      };
    }

    const gap = typeof entry.gap === "string" && entry.gap.length > 0 ? entry.gap : undefined;

    criteriaResults.push({
      name: entry.name,
      passed: entry.passed,
      gap,
    });
  }

  // Populate any rubric criteria missing from the grader response as failed
  // (grader may omit criteria it skipped — treat as not evaluated = fail-closed)
  const returnedNames = new Set(criteriaResults.map((c) => c.name));
  for (const criterion of rubric.criteria) {
    if (!returnedNames.has(criterion.name)) {
      criteriaResults.push({
        name: criterion.name,
        passed: false,
        gap: "criterion not evaluated by grader",
      });
    }
  }

  // Determine overall result from required criteria
  const requiredFailing = criteriaResults.filter((c) => !c.passed && isRequired(rubric, c.name));
  const result =
    requiredFailing.length === 0 ? ("satisfied" as const) : ("needs_revision" as const);

  return {
    ok: true,
    value: {
      result,
      iteration,
      criteria: criteriaResults,
      explanation,
    },
  };
}

function isRequired(rubric: OutcomeRubric, criterionName: string): boolean {
  const criterion = rubric.criteria.find((c) => c.name === criterionName);
  // Default: required unless explicitly set to false
  return criterion?.required !== false;
}
