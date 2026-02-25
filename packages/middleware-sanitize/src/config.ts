/**
 * Sanitize middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { RulePreset, SanitizationEvent, SanitizeRule } from "./types.js";

/** Default stream buffer size in characters. */
export const DEFAULT_STREAM_BUFFER_SIZE = 256;

/** Default max recursion depth for JSON walking. */
export const DEFAULT_JSON_WALK_MAX_DEPTH = 10;

const VALID_PRESETS = new Set<string>([
  "prompt-injection",
  "control-chars",
  "html-tags",
  "zero-width",
]);

export interface SanitizeMiddlewareConfig {
  /** Explicit rules to apply. At least one of `rules` or `presets` required. */
  readonly rules?: readonly SanitizeRule[] | undefined;
  /** Named preset rule sets. At least one of `rules` or `presets` required. */
  readonly presets?: readonly RulePreset[] | undefined;
  /** Sliding window buffer size for streaming output (default: 256 chars). */
  readonly streamBufferSize?: number | undefined;
  /** Called when a sanitization rule fires. */
  readonly onSanitization?: ((event: SanitizationEvent) => void) | undefined;
  /** Whether to sanitize tool call input (default: true). */
  readonly sanitizeToolInput?: boolean | undefined;
  /** Whether to sanitize tool call output (default: true). */
  readonly sanitizeToolOutput?: boolean | undefined;
  /** Max recursion depth for JSON walking in tool I/O (default: 10). */
  readonly jsonWalkMaxDepth?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: RETRYABLE_DEFAULTS.VALIDATION },
  };
}

export function validateSanitizeConfig(
  config: unknown,
): Result<SanitizeMiddlewareConfig, KoiError> {
  if (!isRecord(config)) {
    return validationError("Config must be a non-null object");
  }

  const hasRules = config.rules !== undefined;
  const hasPresets = config.presets !== undefined;

  if (!hasRules && !hasPresets) {
    return validationError("Config requires at least one of 'rules' or 'presets'");
  }

  if (hasRules) {
    if (!Array.isArray(config.rules)) {
      return validationError("'rules' must be an array of SanitizeRule objects");
    }
    for (const rule of config.rules as unknown[]) {
      if (!isRecord(rule)) {
        return validationError("Each rule must be a non-null object");
      }
      if (typeof rule.name !== "string" || rule.name.length === 0) {
        return validationError("Each rule must have a non-empty 'name' string");
      }
      if (!(rule.pattern instanceof RegExp)) {
        return validationError(`Rule "${String(rule.name)}": 'pattern' must be a RegExp`);
      }
      if ((rule.pattern as RegExp).global) {
        return validationError(`Rule "${String(rule.name)}": pattern must not have the 'g' flag`);
      }
      if (!isRecord(rule.action) || typeof rule.action.kind !== "string") {
        return validationError(
          `Rule "${String(rule.name)}": 'action' must be an object with a 'kind' field`,
        );
      }
    }
  }

  if (hasPresets) {
    if (!Array.isArray(config.presets)) {
      return validationError("'presets' must be an array of preset names");
    }
    const allValid = (config.presets as unknown[]).every(
      (p: unknown) => typeof p === "string" && VALID_PRESETS.has(p),
    );
    if (!allValid) {
      return validationError(
        "presets must contain only valid preset names: prompt-injection, control-chars, html-tags, zero-width",
      );
    }
  }

  if (config.streamBufferSize !== undefined) {
    if (
      typeof config.streamBufferSize !== "number" ||
      !Number.isFinite(config.streamBufferSize) ||
      config.streamBufferSize <= 0
    ) {
      return validationError("streamBufferSize must be a finite positive number");
    }
  }

  if (config.jsonWalkMaxDepth !== undefined) {
    if (
      typeof config.jsonWalkMaxDepth !== "number" ||
      !Number.isInteger(config.jsonWalkMaxDepth) ||
      config.jsonWalkMaxDepth <= 0
    ) {
      return validationError("jsonWalkMaxDepth must be a positive integer");
    }
  }

  if (config.sanitizeToolInput !== undefined && typeof config.sanitizeToolInput !== "boolean") {
    return validationError("sanitizeToolInput must be a boolean");
  }

  if (config.sanitizeToolOutput !== undefined && typeof config.sanitizeToolOutput !== "boolean") {
    return validationError("sanitizeToolOutput must be a boolean");
  }

  if (config.onSanitization !== undefined && typeof config.onSanitization !== "function") {
    return validationError("onSanitization must be a function");
  }

  const validated: unknown = config;
  return { ok: true, value: validated as SanitizeMiddlewareConfig };
}
