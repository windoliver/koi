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
}

export interface ResolvedStrictAgenticConfig {
  readonly enabled: boolean;
  readonly maxFillerRetries: number;
  readonly feedbackMessage: string | undefined;
  readonly isUserQuestion: (output: string) => boolean;
  readonly isExplicitDone: (output: string) => boolean;
}

export const DEFAULT_STRICT_AGENTIC_CONFIG: {
  readonly enabled: true;
  readonly maxFillerRetries: 3;
} = {
  enabled: true,
  maxFillerRetries: 3,
} as const satisfies Pick<StrictAgenticConfig, "enabled" | "maxFillerRetries">;

/** Window of trailing characters searched for the explicit-done signal. */
const EXPLICIT_DONE_WINDOW = 80;

/** Completion keywords: must appear in the trailing window to be recognised. */
const EXPLICIT_DONE_WORD_RE = /\b(done|completed|finished|no further action)\b/i;

/**
 * Negations that disqualify the match even when a completion keyword appears
 * in the trailing window. "I am not done yet" must NOT classify as done.
 * Covers explicit "not", "n't" contractions, "never", and "yet".
 */
const NEGATION_RE =
  /\b(not|never|yet|n't|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|can't|couldn't|shouldn't|wouldn't)\b/i;

function defaultIsUserQuestion(output: string): boolean {
  const trimmed = output.trimEnd();
  return trimmed.length > 0 && trimmed.endsWith("?");
}

function defaultIsExplicitDone(output: string): boolean {
  const tail = output.slice(-EXPLICIT_DONE_WINDOW);
  if (!EXPLICIT_DONE_WORD_RE.test(tail)) return false;
  // Reject if any negation is present in the same window — covers "not done yet",
  // "not yet completed", "have not finished", etc.
  if (NEGATION_RE.test(tail)) return false;
  return true;
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
  if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0) {
    return {
      ok: false,
      error: configError("StrictAgenticConfig.maxFillerRetries must be a non-negative integer"),
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
  };
}
