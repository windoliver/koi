/**
 * Dynamic descriptor discovery — scans packages directory for
 * descriptor exports, enabling hot-loading of new packages.
 *
 * Usage: Call discoverDescriptors() instead of hardcoding ALL_DESCRIPTORS.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "./types.js";

/** Package directory name patterns that may export descriptors. */
const DISCOVERABLE_PREFIXES: readonly string[] = ["middleware-", "channel-", "engine-"];

/** Packages to skip during discovery. */
const SKIP_LIST = new Set([
  "middleware-guardrails",
  "middleware-feedback-loop",
  "middleware-event-trace",
  "middleware-fs-rollback",
]);

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
    const entries = await readdir(packagesDir);
    const discoverable = entries
      .filter((e) => DISCOVERABLE_PREFIXES.some((p) => e.startsWith(p)))
      .filter((e) => !SKIP_LIST.has(e))
      .sort();

    const descriptors: BrickDescriptor<unknown>[] = [];

    const results = await Promise.allSettled(
      discoverable.map(async (dirName) => {
        const distIndex = join(packagesDir, dirName, "dist", "index.js");
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
