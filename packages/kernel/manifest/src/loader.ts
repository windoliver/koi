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
  "skills",
  "permissions",
  "metadata",
  "engine",
  "schedule",
  "webhooks",
  "outboundWebhooks",
  "forge",
  "context",
  "soul",
  "user",
  "deploy",
  "scope",
  "hooks",
] as const;

/** Options for manifest loading. */
export interface LoadOptions {
  /**
   * When true (default), manifests declaring hooks are rejected with an error
   * because the engine does not enforce them yet. Non-runtime callers
   * (catalog discovery, introspection, doctor) should pass `false` to load
   * hook-bearing manifests with a warning instead of an error.
   */
  readonly rejectUnsupportedHooks?: boolean | undefined;
}

/**
 * Loads and validates a koi.yaml manifest from a file path.
 *
 * Pipeline: read file → interpolate env → parse YAML → validate → transform → return.
 *
 * @param filePath - Absolute or relative path to the koi.yaml file
 * @param env - Environment variables map (defaults to `process.env`)
 * @param options - Loading options (e.g., strict hook rejection)
 * @returns `Result<LoadResult, KoiError>` — success with manifest + warnings, or validation error
 */
export async function loadManifest(
  filePath: string,
  env?: Readonly<Record<string, string | undefined>>,
  options?: LoadOptions,
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

  return loadManifestFromString(raw, env, options);
}

/**
 * Loads and validates a koi.yaml manifest from a raw YAML string.
 *
 * Synchronous variant — same pipeline minus file I/O. Useful for testing and embedding.
 *
 * @param yaml - Raw YAML string (may contain `${VAR}` references)
 * @param env - Environment variables map (defaults to `process.env`)
 * @param options - Loading options (e.g., strict hook rejection)
 * @returns `Result<LoadResult, KoiError>` — success with manifest + warnings, or validation error
 */
export function loadManifestFromString(
  yaml: string,
  env?: Readonly<Record<string, string | undefined>>,
  options?: LoadOptions,
): Result<LoadResult, KoiError> {
  const rejectHooks = options?.rejectUnsupportedHooks ?? true;

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
  const unknownFieldWarnings =
    typeof parsed === "object" && parsed !== null
      ? detectUnknownFields(parsed as Record<string, unknown>, KNOWN_FIELDS)
      : [];

  const hooks = validation.data.hooks;
  const hasHooks = hooks !== undefined && hooks.length > 0;

  // In strict mode (default), reject hooks — the engine does not enforce them yet.
  // Non-runtime callers (catalog, introspection) can set rejectUnsupportedHooks:false
  // to parse hook-bearing manifests without assuming enforcement.
  if (hasHooks && rejectHooks) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "Manifest declares hooks, but hook execution is not yet supported. " +
          "Remove the hooks section or wait for runtime hook support before deploying. " +
          "Hook configs are validated but not enforced — declaring them would silently skip safety policies.",
        retryable: false,
        context: { hookCount: hooks.length },
      },
    };
  }

  // Transform to LoadedManifest
  const manifest = transformToLoadedManifest(validation.data);

  // In non-strict mode, warn about unenforced hooks so the info is available
  const hooksWarning =
    hasHooks && !rejectHooks
      ? [
          {
            path: "hooks",
            message:
              "Hooks are declared but not yet enforced at runtime. " +
              "Do not rely on them for safety gating until runtime support ships.",
          },
        ]
      : [];

  const warnings = [...unknownFieldWarnings, ...hooksWarning];

  return { ok: true, value: { manifest, warnings } };
}
