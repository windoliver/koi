/**
 * Post-install integrity verification — ensures installed packages match
 * the declared dependency map and the lockfile.
 *
 * Checks:
 * 1. bun.lock exists and is parseable
 * 2. Each declared package appears in the lockfile
 * 3. Resolved version in lockfile matches the declared version
 * 4. node_modules/<pkg>/package.json exists with matching version
 *
 * Returns a typed Result — INTEGRITY_MISMATCH on any discrepancy.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Result } from "@koi/core";
import type { ForgeError } from "./errors.js";
import { resolveError } from "./errors.js";

// ---------------------------------------------------------------------------
// Lockfile parsing
// ---------------------------------------------------------------------------

interface LockfileEntry {
  readonly name: string;
  readonly version: string;
}

/**
 * Parse bun.lock (JSONC format) and extract package entries.
 *
 * bun.lock is a JSONC file where the "packages" field maps
 * specifiers to arrays. The first element is the resolved identifier
 * in the format `<name>@<version>`.
 */
function parseLockfilePackages(lockContent: string): readonly LockfileEntry[] {
  // Strip single-line comments and trailing commas for JSONC compatibility.
  // bun.lock uses JSONC with trailing commas (e.g., {"a": 1,}).
  const stripped = lockContent.replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([\]}])/g, "$1");
  const parsed: unknown = JSON.parse(stripped);

  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }

  // Type-safe property access without `as Type` assertions
  if (!Object.hasOwn(parsed, "packages")) {
    return [];
  }
  const packages: unknown = (parsed as { readonly packages: unknown }).packages;
  if (typeof packages !== "object" || packages === null) {
    return [];
  }

  return Object.entries(packages as { readonly [k: string]: unknown }).flatMap(([, value]) => {
    if (!Array.isArray(value) || value.length === 0) {
      return [];
    }
    const resolved: unknown = value[0];
    if (typeof resolved !== "string") {
      return [];
    }
    // Format: "<name>@<version>" — handle scoped packages (@scope/name@version)
    const lastAt = resolved.lastIndexOf("@");
    if (lastAt <= 0) {
      return [];
    }
    return [{ name: resolved.slice(0, lastAt), version: resolved.slice(lastAt + 1) }];
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify that installed packages match declared dependencies.
 * Returns ok if all checks pass, INTEGRITY_MISMATCH error otherwise.
 *
 * Skips verification when declaredPackages is empty.
 */
export async function verifyInstallIntegrity(
  workspacePath: string,
  declaredPackages: Readonly<Record<string, string>>,
): Promise<Result<void, ForgeError>> {
  const packageNames = Object.keys(declaredPackages);
  if (packageNames.length === 0) {
    return { ok: true, value: undefined };
  }

  // 1. Read and parse lockfile
  const lockPath = join(workspacePath, "bun.lock");
  // let justified: lockContent must be read from filesystem
  let lockContent: string;
  try {
    lockContent = await readFile(lockPath, "utf8");
  } catch (_: unknown) {
    return {
      ok: false,
      error: resolveError(
        "INTEGRITY_MISMATCH",
        `No bun.lock found at ${lockPath} — cannot verify install integrity`,
      ),
    };
  }

  // let justified: lockEntries must be parsed from lockContent
  let lockEntries: readonly LockfileEntry[];
  try {
    lockEntries = parseLockfilePackages(lockContent);
  } catch (_: unknown) {
    return {
      ok: false,
      error: resolveError("INTEGRITY_MISMATCH", "Failed to parse bun.lock — malformed JSONC"),
    };
  }

  // Build lookup map: name → version from lockfile
  const lockMap = new Map<string, string>();
  for (const entry of lockEntries) {
    lockMap.set(entry.name, entry.version);
  }

  // 2. Check each declared package
  for (const [name, declaredVersion] of Object.entries(declaredPackages)) {
    // Check lockfile presence
    const lockedVersion = lockMap.get(name);
    if (lockedVersion === undefined) {
      return {
        ok: false,
        error: resolveError(
          "INTEGRITY_MISMATCH",
          `Package "${name}" declared but not found in bun.lock`,
        ),
      };
    }

    // Check lockfile version matches
    if (lockedVersion !== declaredVersion) {
      return {
        ok: false,
        error: resolveError(
          "INTEGRITY_MISMATCH",
          `Package "${name}" version mismatch: declared ${declaredVersion}, locked ${lockedVersion}`,
        ),
      };
    }

    // Check node_modules presence + version
    const pkgJsonPath = join(workspacePath, "node_modules", name, "package.json");
    try {
      const pkgJsonContent = await readFile(pkgJsonPath, "utf8");
      const pkgJson: unknown = JSON.parse(pkgJsonContent);
      const installedVersion =
        typeof pkgJson === "object" &&
        pkgJson !== null &&
        "version" in pkgJson &&
        typeof (pkgJson as { readonly version: unknown }).version === "string"
          ? (pkgJson as { readonly version: string }).version
          : undefined;
      if (installedVersion !== declaredVersion) {
        return {
          ok: false,
          error: resolveError(
            "INTEGRITY_MISMATCH",
            `Package "${name}" installed version mismatch: declared ${declaredVersion}, installed ${installedVersion ?? "unknown"}`,
          ),
        };
      }
    } catch (_: unknown) {
      return {
        ok: false,
        error: resolveError(
          "INTEGRITY_MISMATCH",
          `Package "${name}" not found in node_modules at ${pkgJsonPath}`,
        ),
      };
    }
  }

  return { ok: true, value: undefined };
}
