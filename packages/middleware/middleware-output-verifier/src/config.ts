/**
 * Configuration validation for @koi/middleware-output-verifier.
 *
 * Validates raw config input and returns a typed Result.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { VerifierConfig } from "./types.js";

const VALID_ACTIONS = new Set<string>(["block", "warn", "revise"]);

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateDeterministicChecks(
  checks: unknown,
): { readonly ok: false; readonly error: KoiError } | undefined {
  if (!Array.isArray(checks)) {
    return validationError("'deterministic' must be an array");
  }
  for (const [i, check] of (checks as readonly unknown[]).entries()) {
    if (!isRecord(check)) {
      return validationError(`'deterministic[${String(i)}]' must be an object`);
    }
    if (typeof check.name !== "string" || check.name.length === 0) {
      return validationError(`'deterministic[${String(i)}].name' must be a non-empty string`);
    }
    if (typeof check.check !== "function") {
      return validationError(`'deterministic[${String(i)}].check' must be a function`);
    }
    if (typeof check.action !== "string" || !VALID_ACTIONS.has(check.action)) {
      return validationError(
        `'deterministic[${String(i)}].action' must be "block", "warn", or "revise"`,
      );
    }
  }
  return undefined;
}

function validateJudgeConfig(
  judge: unknown,
): { readonly ok: false; readonly error: KoiError } | undefined {
  if (!isRecord(judge)) {
    return validationError("'judge' must be an object");
  }
  if (typeof judge.rubric !== "string" || judge.rubric.length === 0) {
    return validationError("'judge.rubric' must be a non-empty string");
  }
  if (typeof judge.modelCall !== "function") {
    return validationError("'judge.modelCall' must be a function");
  }
  if (
    judge.vetoThreshold !== undefined &&
    (typeof judge.vetoThreshold !== "number" || judge.vetoThreshold < 0 || judge.vetoThreshold > 1)
  ) {
    return validationError("'judge.vetoThreshold' must be a number between 0.0 and 1.0");
  }
  if (
    judge.samplingRate !== undefined &&
    (typeof judge.samplingRate !== "number" || judge.samplingRate < 0 || judge.samplingRate > 1)
  ) {
    return validationError("'judge.samplingRate' must be a number between 0.0 and 1.0");
  }
  if (
    judge.action !== undefined &&
    (typeof judge.action !== "string" || !VALID_ACTIONS.has(judge.action))
  ) {
    return validationError('\'judge.action\' must be "block", "warn", or "revise"');
  }
  if (
    judge.maxContentLength !== undefined &&
    (typeof judge.maxContentLength !== "number" ||
      !Number.isInteger(judge.maxContentLength) ||
      judge.maxContentLength <= 0)
  ) {
    return validationError("'judge.maxContentLength' must be a positive integer");
  }
  if (judge.randomFn !== undefined && typeof judge.randomFn !== "function") {
    return validationError("'judge.randomFn' must be a function");
  }
  return undefined;
}

/**
 * Validates raw config input for the output verifier middleware.
 *
 * At least one of `deterministic` or `judge` must be present.
 */
export function validateVerifierConfig(input: unknown): Result<VerifierConfig, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return validationError("Config must be a non-null object");
  }

  const c = input as Record<string, unknown>;

  const hasDeterministic = c.deterministic !== undefined;
  const hasJudge = c.judge !== undefined;

  if (!hasDeterministic && !hasJudge) {
    return validationError("Config requires at least one of 'deterministic' or 'judge'");
  }

  if (hasDeterministic) {
    const err = validateDeterministicChecks(c.deterministic);
    if (err !== undefined) return err;
  }

  if (hasJudge) {
    const err = validateJudgeConfig(c.judge);
    if (err !== undefined) return err;
  }

  if (
    c.maxRevisions !== undefined &&
    (typeof c.maxRevisions !== "number" || !Number.isInteger(c.maxRevisions) || c.maxRevisions < 0)
  ) {
    return validationError("'maxRevisions' must be a non-negative integer");
  }

  if (
    c.revisionFeedbackMaxLength !== undefined &&
    (typeof c.revisionFeedbackMaxLength !== "number" ||
      !Number.isInteger(c.revisionFeedbackMaxLength) ||
      c.revisionFeedbackMaxLength <= 0)
  ) {
    return validationError("'revisionFeedbackMaxLength' must be a positive integer");
  }

  if (
    c.maxBufferSize !== undefined &&
    (typeof c.maxBufferSize !== "number" ||
      !Number.isInteger(c.maxBufferSize) ||
      c.maxBufferSize <= 0)
  ) {
    return validationError("'maxBufferSize' must be a positive integer");
  }

  if (c.onVeto !== undefined && typeof c.onVeto !== "function") {
    return validationError("'onVeto' must be a function");
  }

  return { ok: true, value: input as VerifierConfig };
}
