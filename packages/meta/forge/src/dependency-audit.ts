/**
 * Dependency audit gate — validates brick package declarations before installation.
 *
 * Checks:
 * - Maximum dependency count
 * - Allowlist/blocklist matching
 * - npm package name format validation
 * - Exact semver only (no ranges, no tags)
 */

import type { Result } from "@koi/core";
import type { DependencyConfig } from "./config.js";
import type { ForgeError } from "./errors.js";
import { resolveError } from "./errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * npm package name validation per npm naming rules:
 * - Scoped: @scope/name
 * - Unscoped: name
 * - Lowercase only, alphanumeric, hyphens, dots, underscores, tildes
 * - Max 214 characters
 */
const NPM_NAME_PATTERN = /^(@[a-z0-9-~][a-z0-9._~-]*\/)?[a-z0-9-~][a-z0-9._~-]*$/;

/** npm enforces a 214-character limit on package names. */
const NPM_NAME_MAX_LENGTH = 214;

/**
 * Exact semver pattern: MAJOR.MINOR.PATCH with optional pre-release/build.
 * Rejects ranges (^, ~, >=, ||), tags (latest, next), and URLs.
 */
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Audit a set of package declarations against the dependency config.
 *
 * Returns `{ ok: true }` if all checks pass, or a descriptive error.
 */
export function auditDependencies(
  packages: Readonly<Record<string, string>>,
  config: DependencyConfig,
): Result<void, ForgeError> {
  const entries = Object.entries(packages);

  // Check max dependency count
  if (entries.length > config.maxDependencies) {
    return {
      ok: false,
      error: resolveError(
        "AUDIT_FAILED",
        `Too many dependencies: ${String(entries.length)} exceeds limit of ${String(config.maxDependencies)}`,
      ),
    };
  }

  for (const [name, version] of entries) {
    // Validate package name format and length
    if (name.length === 0 || name.length > NPM_NAME_MAX_LENGTH || !NPM_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error: resolveError(
          "AUDIT_FAILED",
          `Invalid package name: "${name}" — must be a valid npm package name (lowercase, max ${String(NPM_NAME_MAX_LENGTH)} chars)`,
        ),
      };
    }

    // Validate exact semver (no ranges, no tags)
    if (!EXACT_SEMVER_PATTERN.test(version)) {
      return {
        ok: false,
        error: resolveError(
          "AUDIT_FAILED",
          `Package "${name}" version "${version}" must be exact semver (e.g., "1.2.3"), not a range or tag`,
        ),
      };
    }

    // Check blocklist (takes precedence over allowlist)
    if (config.blockedPackages !== undefined && config.blockedPackages.length > 0) {
      if (config.blockedPackages.includes(name)) {
        return {
          ok: false,
          error: resolveError("AUDIT_FAILED", `Package "${name}" is blocked by dependency policy`),
        };
      }
    }

    // Check allowlist (empty = all allowed)
    if (config.allowedPackages !== undefined && config.allowedPackages.length > 0) {
      if (!config.allowedPackages.includes(name)) {
        return {
          ok: false,
          error: resolveError(
            "AUDIT_FAILED",
            `Package "${name}" is not in the allowed packages list`,
          ),
        };
      }
    }
  }

  return { ok: true, value: undefined };
}

/**
 * Audit transitive dependencies from a bun.lock file.
 *
 * Parses the JSONC lockfile, extracts all package names from the `packages`
 * object, and rejects if any transitive dep is on the blocklist or the total
 * count exceeds `maxTransitiveDependencies`.
 */
export function auditTransitiveDependencies(
  lockfileContent: string,
  config: DependencyConfig,
): Result<void, ForgeError> {
  // bun.lock is JSONC (JSON with trailing commas). Strip trailing commas for JSON.parse.
  const jsonStr = lockfileContent.replace(/,(\s*[}\]])/g, "$1");

  // let justified: parsed is conditionally assigned from try/catch
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (_: unknown) {
    // If we can't parse the lockfile, skip transitive audit rather than block install
    return { ok: true, value: undefined };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: true, value: undefined };
  }

  const packages = (parsed as Record<string, unknown>).packages;
  if (typeof packages !== "object" || packages === null) {
    return { ok: true, value: undefined };
  }

  const packageNames = Object.keys(packages as Record<string, unknown>);

  // Check transitive dependency count limit
  if (packageNames.length > config.maxTransitiveDependencies) {
    return {
      ok: false,
      error: resolveError(
        "AUDIT_FAILED",
        `Too many transitive dependencies: ${String(packageNames.length)} exceeds limit of ${String(config.maxTransitiveDependencies)}`,
      ),
    };
  }

  // Check blocklist
  if (config.blockedPackages !== undefined && config.blockedPackages.length > 0) {
    const blockedSet = new Set(config.blockedPackages);
    for (const name of packageNames) {
      if (blockedSet.has(name)) {
        return {
          ok: false,
          error: resolveError(
            "AUDIT_FAILED",
            `Transitive dependency "${name}" is blocked by dependency policy`,
          ),
        };
      }
    }
  }

  return { ok: true, value: undefined };
}
