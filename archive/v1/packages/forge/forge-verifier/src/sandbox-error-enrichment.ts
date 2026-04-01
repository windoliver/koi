/**
 * Sandbox error enrichment -- adds code snippets, remediation suggestions,
 * and sanitized input data to raw sandbox errors for better diagnostics.
 */

import type { SandboxError, SandboxErrorCode } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeSnippet {
  readonly lines: readonly string[];
  readonly startLine: number;
  readonly highlightLine?: number;
}

export interface EnrichedSandboxError {
  readonly code: SandboxErrorCode;
  readonly message: string;
  readonly durationMs: number;
  readonly stack?: string;
  readonly snippet?: CodeSnippet;
  readonly remediation: string;
  readonly sanitizedInput?: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNIPPET_CONTEXT = 3;
const MAX_STRING_LENGTH = 200;
const MAX_RECURSION_DEPTH = 3;
const SENSITIVE_KEY_PATTERN = /secret|password|token|key|auth/i;
const LINE_NUMBER_PATTERN = /:(\d+):|line (\d+)/i;

// ---------------------------------------------------------------------------
// extractSnippet
// ---------------------------------------------------------------------------

/**
 * Parse a line number from a stack trace and extract surrounding lines
 * from the implementation source for context.
 */
export function extractSnippet(
  implementation: string,
  stack: string | undefined,
): CodeSnippet | undefined {
  if (stack === undefined) {
    return undefined;
  }

  const match = LINE_NUMBER_PATTERN.exec(stack);
  if (match === null) {
    return undefined;
  }

  const lineStr = match[1] ?? match[2];
  if (lineStr === undefined) {
    return undefined;
  }

  const lineNumber = Number.parseInt(lineStr, 10);
  if (Number.isNaN(lineNumber) || lineNumber < 1) {
    return undefined;
  }

  const allLines = implementation.split("\n");
  const zeroIndex = lineNumber - 1;

  const startIndex = Math.max(0, zeroIndex - SNIPPET_CONTEXT);
  const endIndex = Math.min(allLines.length, zeroIndex + SNIPPET_CONTEXT + 1);

  const lines = allLines.slice(startIndex, endIndex);

  return {
    lines,
    startLine: startIndex + 1,
    highlightLine: lineNumber,
  };
}

// ---------------------------------------------------------------------------
// computeRemediation
// ---------------------------------------------------------------------------

const REMEDIATION_MAP: Readonly<Record<SandboxErrorCode, string>> = {
  TIMEOUT: "Consider optimizing the implementation or increasing sandboxTimeoutMs in forge config",
  OOM: "Reduce memory usage — avoid large data structures, streams, or unbounded allocations",
  CRASH: "Check for runtime errors — null dereference, import issues, or syntax problems",
  PERMISSION: "The sandbox restricts filesystem and network access — remove disallowed operations",
} as const;

/**
 * Return a human-readable remediation suggestion for the given error code.
 */
export function computeRemediation(code: SandboxErrorCode): string {
  return REMEDIATION_MAP[code];
}

// ---------------------------------------------------------------------------
// sanitizeInput
// ---------------------------------------------------------------------------

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_RECURSION_DEPTH) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
      : value;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }

  const obj = value as Readonly<Record<string, unknown>>;
  const entries = Object.entries(obj).map(([k, v]) => {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      return [k, "[REDACTED]"] as const;
    }
    return [k, sanitizeValue(v, depth + 1)] as const;
  });

  return Object.fromEntries(entries) as unknown;
}

/**
 * Sanitize input data for inclusion in error reports:
 * - Truncate long strings
 * - Redact sensitive keys (secret, password, token, key, auth)
 * - Cap recursion at 3 levels
 */
export function sanitizeInput(input: unknown): unknown {
  return sanitizeValue(input, 0);
}

// ---------------------------------------------------------------------------
// enrichSandboxError
// ---------------------------------------------------------------------------

/**
 * Compose snippet extraction, remediation lookup, and input sanitization
 * into a single enriched sandbox error for diagnostics.
 */
export function enrichSandboxError(
  error: SandboxError,
  implementation: string,
  input: unknown,
): EnrichedSandboxError {
  const snippet = extractSnippet(implementation, error.stack);
  const remediation = computeRemediation(error.code);
  const sanitizedInput = sanitizeInput(input);

  return {
    code: error.code,
    message: error.message,
    durationMs: error.durationMs,
    ...(error.stack !== undefined ? { stack: error.stack } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    remediation,
    sanitizedInput,
  };
}
