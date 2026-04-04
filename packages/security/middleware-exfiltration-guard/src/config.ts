/**
 * Configuration types for the exfiltration guard middleware.
 */

import type { KoiError } from "@koi/core";
import type { SecretPattern } from "@koi/redaction";

/** Action to take when exfiltration is detected. */
export type ExfiltrationAction = "block" | "redact" | "warn";

/** Event fired when exfiltration is detected. */
export interface ExfiltrationEvent {
  readonly location: "tool-input" | "model-output";
  readonly toolId?: string | undefined;
  readonly matchCount: number;
  readonly kinds: readonly string[];
  readonly action: ExfiltrationAction;
}

/** Configuration for createExfiltrationGuardMiddleware. */
export interface ExfiltrationGuardConfig {
  /** Action on detection. Default: "block". */
  readonly action: ExfiltrationAction;
  /** Additional secret patterns beyond the built-in 13 + decoding detectors. */
  readonly customPatterns: readonly SecretPattern[];
  /** Callback fired on every detection for observability/audit. */
  readonly onDetection: ((event: ExfiltrationEvent) => void) | undefined;
  /** Max string length to scan (skip oversized for ReDoS safety). Default: 100_000. */
  readonly maxStringLength: number;
  /** Scan tool input arguments. Default: true. */
  readonly scanToolInput: boolean;
  /** Scan model output text. Default: true. */
  readonly scanModelOutput: boolean;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set(["block", "redact", "warn"]);

/** Default config values. */
export const DEFAULT_EXFILTRATION_GUARD_CONFIG: ExfiltrationGuardConfig = {
  action: "block",
  customPatterns: [],
  onDetection: undefined,
  maxStringLength: 100_000,
  scanToolInput: true,
  scanModelOutput: true,
} as const;

/** Result type for config validation. */
type ValidateResult =
  | { readonly ok: true; readonly value: ExfiltrationGuardConfig }
  | { readonly ok: false; readonly error: KoiError };

/** Validate and normalize a partial config into a full ExfiltrationGuardConfig. */
export function validateExfiltrationGuardConfig(
  input: Partial<ExfiltrationGuardConfig> | undefined,
): ValidateResult {
  const config = { ...DEFAULT_EXFILTRATION_GUARD_CONFIG, ...input };

  if (!VALID_ACTIONS.has(config.action)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid exfiltration action "${config.action}" — must be "block", "redact", or "warn"`,
        retryable: false,
      },
    };
  }

  if (typeof config.maxStringLength !== "number" || config.maxStringLength <= 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "maxStringLength must be a positive number",
        retryable: false,
      },
    };
  }

  if (config.onDetection !== undefined && typeof config.onDetection !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "onDetection must be a function or undefined",
        retryable: false,
      },
    };
  }

  return { ok: true, value: config };
}
