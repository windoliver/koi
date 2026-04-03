/**
 * Dynamic descriptor discovery — scans packages directory for
 * descriptor exports, enabling hot-loading of new packages.
 *
 * Usage: Call discoverDescriptors() instead of hardcoding ALL_DESCRIPTORS.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "./types.js";

/** Package directory name patterns that may export descriptors. */
const DISCOVERABLE_PREFIXES: readonly string[] = ["middleware-", "channel-", "engine-", "search-"];

/** Packages to skip during discovery. */
const SKIP_LIST = new Set([
  "middleware-guardrails",
  "middleware-feedback-loop",
  "middleware-event-trace",
  "middleware-fs-rollback",
]);

function isDiscoverablePackage(name: string): boolean {
  return DISCOVERABLE_PREFIXES.some((prefix) => name.startsWith(prefix)) && !SKIP_LIST.has(name);
}

/**
 * Checks if a module export looks like a valid BrickDescriptor.
 */
function isDescriptor(value: unknown): value is BrickDescriptor<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.kind === "string" &&
    typeof obj.name === "string" &&
    typeof obj.optionsValidator === "function" &&
    typeof obj.factory === "function"
  );
}

/**
 * Scans a packages directory for L2 packages that export a `descriptor`.
 *
 * Imports each package's dist/index.js and checks for a descriptor export.
 * Returns all discovered descriptors. Packages without descriptors are silently skipped.
 */
export async function discoverDescriptors(
  packagesDir: string,
): Promise<Result<readonly BrickDescriptor<unknown>[], KoiError>> {
  try {
    const entries = await readdir(packagesDir, { encoding: "utf8", withFileTypes: true });
    const discoverableDirs: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      if (isDiscoverablePackage(entry.name)) {
        discoverableDirs.push(join(packagesDir, entry.name));
        continue;
      }

      const categoryDir = join(packagesDir, entry.name);
      let nestedEntries: Dirent[];
      try {
        nestedEntries = await readdir(categoryDir, { encoding: "utf8", withFileTypes: true });
      } catch {
        continue;
      }

      for (const nestedEntry of nestedEntries) {
        if (!nestedEntry.isDirectory() || !isDiscoverablePackage(nestedEntry.name)) {
          continue;
        }
        discoverableDirs.push(join(categoryDir, nestedEntry.name));
      }
    }

    discoverableDirs.sort();

    const descriptors: BrickDescriptor<unknown>[] = [];

    const results = await Promise.allSettled(
      discoverableDirs.map(async (packageDir) => {
        const distIndex = join(packageDir, "dist", "index.js");
        try {
          const mod = await import(distIndex);
          if (isDescriptor(mod.descriptor)) {
            return mod.descriptor as BrickDescriptor<unknown>;
          }
          return undefined;
        } catch {
          // Package not built or no descriptor — skip
          return undefined;
        }
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value !== undefined) {
        descriptors.push(result.value);
      }
    }

    return { ok: true, value: descriptors };
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Failed to scan packages directory: ${e instanceof Error ? e.message : String(e)}`,
        retryable: RETRYABLE_DEFAULTS.INTERNAL,
      },
    };
  }
}
