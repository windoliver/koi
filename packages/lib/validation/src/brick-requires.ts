/**
 * Pure BrickRequires validation — bins, env, platform checks.
 *
 * Operates only on L0 types. Extracted from @koi/forge-tools so L2 packages
 * (like @koi/skills) can validate requirements without importing from peer L2.
 */

import type { BrickRequires, KoiError, Result } from "@koi/core";

export type RequiresViolationKind = "bin" | "env" | "platform";

export interface RequiresViolation {
  readonly kind: RequiresViolationKind;
  readonly name: string;
}

/**
 * Validates the subset of BrickRequires that can be checked locally without
 * tool/agent/package context: bins, env, and platform.
 *
 * Returns the first violation found (fail-fast). No requires → always satisfied.
 */
export function validateBrickRequires(requires: BrickRequires | undefined): Result<void, KoiError> {
  if (requires === undefined) {
    return { ok: true, value: undefined };
  }

  // 1. Binary availability (PATH lookup)
  if (requires.bins !== undefined) {
    for (const bin of requires.bins) {
      if (Bun.which(bin) === null) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Required binary not found on PATH: ${bin}`,
            retryable: false,
            context: { kind: "bin", name: bin },
          },
        };
      }
    }
  }

  // 2. Environment variables
  if (requires.env !== undefined) {
    for (const varName of requires.env) {
      if (process.env[varName] === undefined) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Required environment variable not set: ${varName}`,
            retryable: false,
            context: { kind: "env", name: varName },
          },
        };
      }
    }
  }

  // 3. Platform check
  if (requires.platform !== undefined && requires.platform.length > 0) {
    if (!requires.platform.includes(process.platform)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Unsupported platform: ${process.platform} (requires: ${requires.platform.join(", ")})`,
          retryable: false,
          context: { kind: "platform", name: process.platform },
        },
      };
    }
  }

  return { ok: true, value: undefined };
}
