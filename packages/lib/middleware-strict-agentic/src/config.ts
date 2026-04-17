/**
 * Configuration surface for @koi/middleware-strict-agentic.
 *
 * All fields are optional on input. `validateStrictAgenticConfig` rejects
 * structurally bad input. `resolveStrictAgenticConfig` applies defaults and
 * materialises predicate functions so downstream code can call them unconditionally.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export interface StrictAgenticConfig {
  readonly enabled: boolean;
  readonly maxFillerRetries: number;
  readonly feedbackMessage?: string;
  readonly isUserQuestion?: (output: string) => boolean;
  readonly isExplicitDone?: (output: string) => boolean;
  readonly isFillerOutput?: (output: string) => boolean;
}

export interface ResolvedStrictAgenticConfig {
  readonly enabled: boolean;
  readonly maxFillerRetries: number;
  readonly feedbackMessage: string | undefined;
  readonly isUserQuestion: (output: string) => boolean;
  readonly isExplicitDone: (output: string) => boolean;
  readonly isFillerOutput: (output: string) => boolean;
}

export const DEFAULT_STRICT_AGENTIC_CONFIG: {
  readonly enabled: true;
  readonly maxFillerRetries: 2;
} = {
  enabled: true,
  // Default 2 aligns with engine DEFAULT_MAX_STOP_RETRIES=3: two filler
  // blocks happen within budget, the third stop-gate call releases with
  // the breaker signal. A value of N means "block N times, release on
  // attempt N+1."
  maxFillerRetries: 2,
} as const satisfies Pick<StrictAgenticConfig, "enabled" | "maxFillerRetries">;

/** Completion keywords recognised by the default `isExplicitDone` predicate. */
const EXPLICIT_DONE_WORD_RE = /\b(done|completed|finished|no further action)\b/i;

/**
 * Negations that disqualify a completion keyword in the same clause.
 * Covers "not", "n't" contractions, "never", and "yet".
 */
const NEGATION_RE =
  /\b(not|never|yet|n't|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|can't|couldn't|shouldn't|wouldn't)\b/i;

/**
 * Forward-work indicators after the completion keyword in the same clause.
 * If present, the turn is still describing upcoming work and must not be
 * exempted: "I completed step 1, will now continue" is NOT done.
 */
const FORWARD_WORK_RE =
  /\b(will|shall|next|then|continue|continuing|proceed|proceeding|apply|applying|start|starting|now)\b/i;

/** Clause terminators: sentence punctuation plus `;` and em-dash variants. */
const CLAUSE_SPLITTER = /[.!?;—]+/;

/**
 * Positive filler-language patterns — first-person-future constructions.
 * The classifier blocks ONLY on a match, so the set is deliberately narrow.
 *
 * `let me <verb>` is matched for action-oriented phrases like "Let me inspect
 * the file." but excludes the benign "let me know ..." form via negative
 * lookahead. Bare `let's` and `next step` are excluded because they also
 * appear in legitimate final answers ("Let's keep the current schema.",
 * "Next step is deployment approval.").
 */
const FILLER_PATTERN_RE =
  /\b(i will|i'll|i am going to|i'm going to|let me (?!know\b)(?:now\s+)?\w+|here is my plan|here's my plan|i'm about to|the plan is|first[,.:]? i(?:'ll| will)|next[,.:]? i(?:'ll| will))\b/i;

/**
 * User-directed question starters. Conservative list of explicit
 * second-person / confirmation-seeking patterns. Keeps self-directed
 * rhetorical questions like "Need to inspect the logs?" or "Run the
 * migration now?" OUT of the exemption so they still block as filler.
 */
const USER_DIRECTED_Q_STARTERS_RE =
  /^(should|shall|may|could|can)\s+i\b|^(are|do|does|did|can|could|would|will|shall|is|was|have|has)\s+you\b/i;

function defaultIsUserQuestion(output: string): boolean {
  const trimmed = output.trimEnd();
  if (!trimmed.endsWith("?")) return false;
  // Inspect the final sentence — everything after the last sentence
  // terminator (and before the closing `?`).
  const withoutMark = trimmed.slice(0, -1).trim();
  const lastSentence =
    withoutMark
      .split(/[.!?]+/)
      .at(-1)
      ?.trim() ?? "";
  if (lastSentence.length === 0) return false;
  // Accept if the question is explicitly addressed to the user (starts with
  // "Should I", "Can you", "Do you", etc.) OR mentions "you" as a pronoun
  // anywhere in the final sentence (covers "I will do X, should I check
  // with you first?" etc.).
  return USER_DIRECTED_Q_STARTERS_RE.test(lastSentence) || /\byou\b/i.test(lastSentence);
}

function defaultIsExplicitDone(output: string): boolean {
  // Only the final clause counts. Status text like "Analysis completed.
  // Next I will edit the file." is split into ["Analysis completed",
  // "Next I will edit the file"] — the last clause has no completion word
  // and the turn is correctly NOT exempted.
  const clauses = output
    .split(CLAUSE_SPLITTER)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const last = clauses.at(-1);
  if (last === undefined) return false;
  if (!EXPLICIT_DONE_WORD_RE.test(last)) return false;
  if (NEGATION_RE.test(last)) return false;
  // Reject same-clause forward-work: "I finished writing, will proceed".
  if (FORWARD_WORK_RE.test(last)) return false;
  return true;
}

function defaultIsFillerOutput(output: string): boolean {
  return FILLER_PATTERN_RE.test(output);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError(message: string): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
}

type Predicate = (output: string) => boolean;

function extractPredicate(
  value: unknown,
  fieldName: string,
): Result<Predicate | undefined, KoiError> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "function") {
    return {
      ok: false,
      error: configError(`StrictAgenticConfig.${fieldName} must be a function if provided`),
    };
  }
  const fn: Predicate = (output: string) => (value as (s: string) => boolean)(output);
  return { ok: true, value: fn };
}

export function validateStrictAgenticConfig(input: unknown): Result<StrictAgenticConfig, KoiError> {
  if (!isPlainObject(input)) {
    return { ok: false, error: configError("StrictAgenticConfig must be a plain object") };
  }

  const enabled = input.enabled ?? DEFAULT_STRICT_AGENTIC_CONFIG.enabled;
  if (typeof enabled !== "boolean") {
    return { ok: false, error: configError("StrictAgenticConfig.enabled must be a boolean") };
  }

  const retries = input.maxFillerRetries ?? DEFAULT_STRICT_AGENTIC_CONFIG.maxFillerRetries;
  if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 1) {
    // Must be >= 1. Zero would trip the breaker on the first filler and
    // silently disable blocking while `enabled` is still true — an unsafe
    // footgun. Integrators who want to disable the guard set `enabled: false`.
    return {
      ok: false,
      error: configError("StrictAgenticConfig.maxFillerRetries must be an integer >= 1"),
    };
  }

  const feedback = input.feedbackMessage;
  if (feedback !== undefined && typeof feedback !== "string") {
    return {
      ok: false,
      error: configError("StrictAgenticConfig.feedbackMessage must be a string if provided"),
    };
  }

  const isUserQuestionResult = extractPredicate(input.isUserQuestion, "isUserQuestion");
  if (!isUserQuestionResult.ok) {
    return isUserQuestionResult;
  }

  const isExplicitDoneResult = extractPredicate(input.isExplicitDone, "isExplicitDone");
  if (!isExplicitDoneResult.ok) {
    return isExplicitDoneResult;
  }

  const isFillerOutputResult = extractPredicate(input.isFillerOutput, "isFillerOutput");
  if (!isFillerOutputResult.ok) {
    return isFillerOutputResult;
  }

  const value: StrictAgenticConfig = {
    enabled,
    maxFillerRetries: retries,
    ...(typeof feedback === "string" ? { feedbackMessage: feedback } : {}),
    ...(isUserQuestionResult.value !== undefined
      ? { isUserQuestion: isUserQuestionResult.value }
      : {}),
    ...(isExplicitDoneResult.value !== undefined
      ? { isExplicitDone: isExplicitDoneResult.value }
      : {}),
    ...(isFillerOutputResult.value !== undefined
      ? { isFillerOutput: isFillerOutputResult.value }
      : {}),
  };

  return { ok: true, value };
}

export function resolveStrictAgenticConfig(
  config: Partial<StrictAgenticConfig>,
): ResolvedStrictAgenticConfig {
  return {
    enabled: config.enabled ?? DEFAULT_STRICT_AGENTIC_CONFIG.enabled,
    maxFillerRetries: config.maxFillerRetries ?? DEFAULT_STRICT_AGENTIC_CONFIG.maxFillerRetries,
    feedbackMessage: config.feedbackMessage,
    isUserQuestion: config.isUserQuestion ?? defaultIsUserQuestion,
    isExplicitDone: config.isExplicitDone ?? defaultIsExplicitDone,
    isFillerOutput: config.isFillerOutput ?? defaultIsFillerOutput,
  };
}
