/**
 * Static descriptor discovery — loads descriptors from a pre-built
 * JSON manifest instead of scanning the filesystem.
 *
 * Falls back to dynamic scanning when the manifest is missing (dev mode).
 */

import { join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import { discoverDescriptors } from "./discover.js";
import type { BrickDescriptor, ResolveKind } from "./types.js";

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/** A single entry in the descriptor manifest (metadata only, no factory). */
export interface ManifestEntry {
  readonly kind: ResolveKind;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly packagePath: string;
}

/** Shape of the descriptor-manifest.json file. */
export interface DescriptorManifest {
  readonly descriptors: readonly ManifestEntry[];
}

// ---------------------------------------------------------------------------
// Manifest path
// ---------------------------------------------------------------------------

/** Default path to the generated manifest JSON, relative to this module. */
const DEFAULT_MANIFEST_PATH = join(import.meta.dir, "descriptor-manifest.json");

// ---------------------------------------------------------------------------
// Static loader
// ---------------------------------------------------------------------------

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
 * Loads descriptors from a pre-built JSON manifest.
 *
 * For each manifest entry, performs a targeted `import(packagePath)`
 * to retrieve the factory function. Entries whose package cannot be
 * imported are silently skipped.
 */
export async function discoverDescriptorsFromManifest(
  manifestPath?: string,
): Promise<Result<readonly BrickDescriptor<unknown>[], KoiError>> {
  const resolvedPath = manifestPath ?? DEFAULT_MANIFEST_PATH;

  try {
    const file = Bun.file(resolvedPath);
    const exists = await file.exists();

    if (!exists) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Descriptor manifest not found at ${resolvedPath}`,
          retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
        },
      };
    }

    const raw: unknown = await file.json();

    if (
      typeof raw !== "object" ||
      raw === null ||
      !Array.isArray((raw as Record<string, unknown>).descriptors)
    ) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Descriptor manifest has invalid format — expected { descriptors: [...] }",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    const manifest = raw as DescriptorManifest;
    const descriptors: BrickDescriptor<unknown>[] = [];

    const results = await Promise.allSettled(
      manifest.descriptors.map(async (entry) => {
        const distIndex = join(entry.packagePath, "dist", "index.js");
        try {
          const mod = await import(distIndex);
          if (isDescriptor(mod.descriptor)) {
            return mod.descriptor as BrickDescriptor<unknown>;
          }
          return undefined;
        } catch {
          // Package not available at runtime — skip
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
        message: `Failed to load descriptor manifest: ${e instanceof Error ? e.message : String(e)}`,
        retryable: RETRYABLE_DEFAULTS.INTERNAL,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Auto-detection: static manifest first, dynamic scanning fallback
// ---------------------------------------------------------------------------

/**
 * Discovers descriptors using static manifest when available,
 * falling back to dynamic filesystem scanning.
 *
 * - In production/binary builds: reads the pre-built manifest for
 *   targeted imports (no directory scanning needed).
 * - In development: falls back to `discoverDescriptors()` when
 *   the manifest file is missing.
 */
export async function discoverDescriptorsAuto(
  packagesDir: string,
  manifestPath?: string,
): Promise<Result<readonly BrickDescriptor<unknown>[], KoiError>> {
  const staticResult = await discoverDescriptorsFromManifest(manifestPath);

  if (staticResult.ok) {
    return staticResult;
  }

  // Manifest missing or invalid — fall back to dynamic scanning
  return discoverDescriptors(packagesDir);
}
