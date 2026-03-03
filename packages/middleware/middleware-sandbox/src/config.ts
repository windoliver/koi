/**
 * Sandbox middleware configuration and validation.
 */

import type { TrustTier } from "@koi/core/ecs";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { ResourceLimits, SandboxProfile } from "@koi/core/sandbox-profile";

/** Max output bytes before truncation (1 MB). */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;

/** Grace period added to profile timeout (5 s). */
export const DEFAULT_TIMEOUT_GRACE_MS = 5_000;

/** Tiers that skip sandbox wrapping entirely. */
export const DEFAULT_SKIP_TIERS: readonly TrustTier[] = ["promoted"] as const;

const VALID_TRUST_TIERS = new Set<string>(["sandbox", "verified", "promoted"]);

export interface SandboxMiddlewareConfig {
  /** Maps trust tier to sandbox profile (required). */
  readonly profileFor: (tier: TrustTier) => SandboxProfile;
  /** Resolves tool ID to its trust tier — caller provides ECS closure (required). */
  readonly tierFor: (toolId: string) => TrustTier | undefined;
  /** Max output bytes before truncation (default: 1_048_576 = 1 MB). */
  readonly outputLimitBytes?: number | undefined;
  /** Grace period added to profile timeout (default: 5_000 ms). */
  readonly timeoutGraceMs?: number | undefined;
  /** Tiers to skip entirely — fast pass-through (default: ["promoted"]). */
  readonly skipTiers?: readonly TrustTier[] | undefined;
  /** Per-tool resource limit overrides. */
  readonly perToolOverrides?: ReadonlyMap<string, Partial<ResourceLimits>> | undefined;
  /** If true, unknown tools (tierFor returns undefined) are treated as sandbox (default: true). */
  readonly failClosedOnLookupError?: boolean | undefined;
  /** Called when middleware detects a sandbox violation (timeout). */
  readonly onSandboxError?:
    | ((toolId: string, tier: TrustTier, code: string, message: string) => void)
    | undefined;
  /** Called after every sandboxed tool execution with metrics. */
  readonly onSandboxMetrics?:
    | ((
        toolId: string,
        tier: TrustTier,
        durationMs: number,
        outputBytes: number,
        truncated: boolean,
      ) => void)
    | undefined;
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

export function validateConfig(config: unknown): Result<SandboxMiddlewareConfig, KoiError> {
  if (!isRecord(config)) {
    return validationError("Config must be a non-null object");
  }

  if (typeof config.profileFor !== "function") {
    return validationError(
      "Config requires 'profileFor' as a function mapping TrustTier to SandboxProfile",
    );
  }

  if (typeof config.tierFor !== "function") {
    return validationError("Config requires 'tierFor' as a function resolving toolId to TrustTier");
  }

  if (config.outputLimitBytes !== undefined) {
    if (
      typeof config.outputLimitBytes !== "number" ||
      !Number.isFinite(config.outputLimitBytes) ||
      config.outputLimitBytes <= 0
    ) {
      return validationError("outputLimitBytes must be a finite positive number");
    }
  }

  if (config.timeoutGraceMs !== undefined) {
    if (
      typeof config.timeoutGraceMs !== "number" ||
      !Number.isFinite(config.timeoutGraceMs) ||
      config.timeoutGraceMs < 0
    ) {
      return validationError("timeoutGraceMs must be a finite non-negative number");
    }
  }

  if (config.skipTiers !== undefined) {
    if (!Array.isArray(config.skipTiers)) {
      return validationError("skipTiers must be an array of TrustTier strings");
    }
    const allValid = config.skipTiers.every(
      (t: unknown) => typeof t === "string" && VALID_TRUST_TIERS.has(t),
    );
    if (!allValid) {
      return validationError(
        "skipTiers must contain only valid TrustTier values: sandbox, verified, promoted",
      );
    }
  }

  if (
    config.failClosedOnLookupError !== undefined &&
    typeof config.failClosedOnLookupError !== "boolean"
  ) {
    return validationError("failClosedOnLookupError must be a boolean");
  }

  if (config.onSandboxError !== undefined && typeof config.onSandboxError !== "function") {
    return validationError("onSandboxError must be a function");
  }

  if (config.onSandboxMetrics !== undefined && typeof config.onSandboxMetrics !== "function") {
    return validationError("onSandboxMetrics must be a function");
  }

  // All required + optional fields validated. The isRecord guard narrowed config to
  // Record<string, unknown> which doesn't overlap with SandboxMiddlewareConfig in TS,
  // so we go through unknown — this is the standard pattern for validation functions.
  const validated: unknown = config;
  return { ok: true, value: validated as SandboxMiddlewareConfig };
}
