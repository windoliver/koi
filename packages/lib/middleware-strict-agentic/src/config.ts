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

export const DEFAULT_STRICT_AGENTIC_CONFIG: Pick<
  StrictAgenticConfig,
  "enabled" | "maxFillerRetries"
> = {
  enabled: true,
  maxFillerRetries: 3,
} as const satisfies Pick<StrictAgenticConfig, "enabled" | "maxFillerRetries">;

const EXPLICIT_DONE_RE = /\b(done|completed|finished|no further action)\b/i;

function defaultIsUserQuestion(output: string): boolean {
  const trimmed = output.trimEnd();
  return trimmed.length > 0 && trimmed.endsWith("?");
}

function defaultIsExplicitDone(output: string): boolean {
  return EXPLICIT_DONE_RE.test(output);
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
