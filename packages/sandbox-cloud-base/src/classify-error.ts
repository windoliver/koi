/**
 * Cloud error classification — maps provider errors to SandboxErrorCode.
 *
 * Each cloud provider returns different error shapes. This module provides
 * a generic classifier based on error message patterns, with providers
 * adding their own specific mappings on top.
 */

import type { SandboxErrorCode } from "@koi/core";

/** Classified sandbox error with code and metadata. */
export interface ClassifiedError {
  readonly code: SandboxErrorCode;
  readonly message: string;
  readonly durationMs: number;
}

/** Patterns that indicate a timeout error. */
const TIMEOUT_PATTERNS: readonly RegExp[] = [
  /timeout/i,
  /timed?\s*out/i,
  /deadline\s*exceeded/i,
  /execution\s*time\s*limit/i,
];

/** Patterns that indicate an out-of-memory error. */
const OOM_PATTERNS: readonly RegExp[] = [
  /out\s*of\s*memory/i,
  /oom/i,
  /memory\s*limit/i,
  /memory\s*exceeded/i,
  /killed.*signal\s*9/i,
];

/** Patterns that indicate a permission/auth error. */
const PERMISSION_PATTERNS: readonly RegExp[] = [
  /unauthorized/i,
  /forbidden/i,
  /permission\s*denied/i,
  /auth/i,
  /api\s*key/i,
  /invalid\s*token/i,
  /401/,
  /403/,
];

/**
 * Classify a cloud error into a SandboxErrorCode.
 *
 * Checks error message against known patterns in priority order:
 * 1. TIMEOUT (highest priority — clear operational failure)
 * 2. OOM
 * 3. PERMISSION
 * 4. CRASH (default)
 */
export function classifyCloudError(error: unknown, durationMs: number): ClassifiedError {
  const message = extractErrorMessage(error);

  const code = matchPattern(message);

  return { code, message, durationMs };
}

function matchPattern(message: string): SandboxErrorCode {
  for (const pattern of TIMEOUT_PATTERNS) {
    if (pattern.test(message)) return "TIMEOUT";
  }
  for (const pattern of OOM_PATTERNS) {
    if (pattern.test(message)) return "OOM";
  }
  for (const pattern of PERMISSION_PATTERNS) {
    if (pattern.test(message)) return "PERMISSION";
  }
  return "CRASH";
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
