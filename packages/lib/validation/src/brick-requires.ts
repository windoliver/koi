/**
 * Pure BrickRequires validation — bins, env, platform, credential checks.
 *
 * Operates only on L0 types. Extracted from @koi/forge-tools so L2 packages
 * (like @koi/skills) can validate requirements without importing from peer L2.
 */

import type { BrickRequires, CredentialComponent, KoiError, Result } from "@koi/core";

export type RequiresViolationKind = "bin" | "env" | "platform" | "credential";

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

// ---------------------------------------------------------------------------
// Async credential validation — collects ALL violations (not fail-fast)
// ---------------------------------------------------------------------------

/**
 * Validates the `credentials` field of BrickRequires against a CredentialComponent.
 *
 * Collects all missing/invalid credentials (not fail-fast).
 * If `credentials` is undefined or `credentialComponent` is undefined, trivially passes.
 */
export async function validateCredentialRequires(
  requires: BrickRequires | undefined,
  credentialComponent: CredentialComponent | undefined,
): Promise<Result<void, KoiError>> {
  if (requires?.credentials === undefined) {
    return { ok: true, value: undefined };
  }

  // No credential component → skip credential checks (backward compat)
  if (credentialComponent === undefined) {
    return { ok: true, value: undefined };
  }

  const violations: readonly RequiresViolation[] = [];
  const mutableViolations = violations as RequiresViolation[];

  for (const [name, requirement] of Object.entries(requires.credentials)) {
    if (requirement.ref.trim() === "") {
      mutableViolations.push({ kind: "credential", name });
      continue;
    }

    try {
      const value = await credentialComponent.get(requirement.ref);
      if (value === undefined) {
        mutableViolations.push({ kind: "credential", name });
      }
    } catch (e: unknown) {
      // Propagate credential resolution errors
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Credential resolution failed for "${name}" (ref: ${requirement.ref}): ${e instanceof Error ? e.message : String(e)}`,
          retryable: false,
          context: { kind: "credential", name },
        },
      };
    }
  }

  if (mutableViolations.length > 0) {
    const names = mutableViolations.map((v) => v.name).join(", ");
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Missing credentials: ${names}`,
        retryable: false,
        context: { violations: mutableViolations },
      },
    };
  }

  return { ok: true, value: undefined };
}
