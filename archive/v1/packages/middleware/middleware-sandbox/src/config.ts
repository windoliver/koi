/**
 * Sandbox middleware configuration and validation.
 */

import type { ToolPolicy } from "@koi/core/ecs";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { ResourceLimits, SandboxProfile } from "@koi/core/sandbox-profile";

/** Max output bytes before truncation (1 MB). */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;

/** Grace period added to profile timeout (5 s). */
export const DEFAULT_TIMEOUT_GRACE_MS = 5_000;

export interface SandboxMiddlewareConfig {
  /** Maps tool policy to sandbox profile (required). */
  readonly profileFor: (policy: ToolPolicy) => SandboxProfile;
  /** Resolves tool ID to its policy — caller provides ECS closure (required). */
  readonly policyFor: (toolId: string) => ToolPolicy | undefined;
  /** Max output bytes before truncation (default: 1_048_576 = 1 MB). */
  readonly outputLimitBytes?: number | undefined;
  /** Grace period added to profile timeout (default: 5_000 ms). */
  readonly timeoutGraceMs?: number | undefined;
  /** Per-tool resource limit overrides. */
  readonly perToolOverrides?: ReadonlyMap<string, Partial<ResourceLimits>> | undefined;
  /** If true, unknown tools (policyFor returns undefined) are treated as sandboxed (default: true). */
  readonly failClosedOnLookupError?: boolean | undefined;
  /** Called when middleware detects a sandbox violation (timeout). */
  readonly onSandboxError?:
    | ((toolId: string, policy: ToolPolicy, code: string, message: string) => void)
    | undefined;
  /** Called after every sandboxed tool execution with metrics. */
  readonly onSandboxMetrics?:
    | ((
        toolId: string,
        policy: ToolPolicy,
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
      "Config requires 'profileFor' as a function mapping ToolPolicy to SandboxProfile",
    );
  }

  if (typeof config.policyFor !== "function") {
    return validationError(
      "Config requires 'policyFor' as a function resolving toolId to ToolPolicy",
    );
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

  const validated: unknown = config;
  return { ok: true, value: validated as SandboxMiddlewareConfig };
}
