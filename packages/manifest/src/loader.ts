/**
 * Main loader — reads, interpolates, parses, validates, and transforms koi.yaml manifests.
 */

import type { KoiError, Result } from "@koi/core";
import { zodToKoiError } from "@koi/validation";
import { interpolateEnv } from "./env.js";
import { rawManifestSchema } from "./schema.js";
import { transformToLoadedManifest } from "./transform.js";
import type { LoadResult } from "./types.js";
import { detectUnknownFields } from "./warnings.js";

/** All known top-level fields in a koi.yaml manifest. */
const KNOWN_FIELDS = [
  "name",
  "version",
  "description",
  "model",
  "tools",
  "channels",
  "middleware",
  "permissions",
  "metadata",
  "engine",
  "schedule",
  "webhooks",
  "forge",
  "context",
] as const;

/**
 * Loads and validates a koi.yaml manifest from a file path.
 *
 * Pipeline: read file → interpolate env → parse YAML → validate → transform → return.
 *
 * @param filePath - Absolute or relative path to the koi.yaml file
 * @param env - Environment variables map (defaults to `process.env`)
 * @returns `Result<LoadResult, KoiError>` — success with manifest + warnings, or validation error
 */
export async function loadManifest(
  filePath: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<Result<LoadResult, KoiError>> {
  // Read file
  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Failed to read manifest file: ${filePath}`,
        retryable: false,
        cause,
        context: { filePath },
      },
    };
  }

  return loadManifestFromString(raw, env);
}

/**
 * Loads and validates a koi.yaml manifest from a raw YAML string.
 *
 * Synchronous variant — same pipeline minus file I/O. Useful for testing and embedding.
 *
 * @param yaml - Raw YAML string (may contain `${VAR}` references)
 * @param env - Environment variables map (defaults to `process.env`)
 * @returns `Result<LoadResult, KoiError>` — success with manifest + warnings, or validation error
 */
export function loadManifestFromString(
  yaml: string,
  env?: Readonly<Record<string, string | undefined>>,
): Result<LoadResult, KoiError> {
  // Interpolate env vars
  const interpolated = interpolateEnv(yaml, env);

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(interpolated);
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `YAML parse error: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
        cause,
      },
    };
  }

  // Validate with Zod
  const validation = rawManifestSchema.safeParse(parsed);
  if (!validation.success) {
    return { ok: false, error: zodToKoiError(validation.error, "Manifest validation failed") };
  }

  // Detect unknown fields (warnings, not errors)
  const warnings =
    typeof parsed === "object" && parsed !== null
      ? detectUnknownFields(parsed as Record<string, unknown>, KNOWN_FIELDS)
      : [];

  // Transform to LoadedManifest
  const manifest = transformToLoadedManifest(validation.data);

  return { ok: true, value: { manifest, warnings } };
}
