/**
 * Filesystem backend dispatch — resolves manifest config to a FileSystemBackend.
 *
 * Follows the existing resolveAdapter()/resolveChannel() pattern in create-runtime.ts.
 * Dispatch logic lives here (L3) instead of L1, keeping the engine vendor-free.
 */

import type { FileSystemBackend, FileSystemConfig, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { createLocalFileSystem } from "@koi/fs-local";
import { createNexusFileSystem, validateNexusFileSystemConfig } from "@koi/fs-nexus";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schema for manifest-level filesystem config (internal)
// ---------------------------------------------------------------------------

const fileSystemConfigSchema = z
  .object({
    backend: z.enum(["local", "nexus"]).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    operations: z.array(z.enum(["read", "write", "edit"])).optional(),
  })
  .strict();

/**
 * Validate raw manifest input as a FileSystemConfig.
 *
 * Returns `Result<FileSystemConfig, KoiError>` — never throws for validation errors.
 * Use this to validate YAML/JSON manifest `filesystem:` sections.
 */
export function validateFileSystemConfig(raw: unknown): Result<FileSystemConfig, KoiError> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: {} };
  }
  const result = fileSystemConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues;
    const messages = issues
      .map((i: z.core.$ZodIssue) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid filesystem config: ${messages}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: result.data as FileSystemConfig };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Resolve a FileSystemConfig to a concrete FileSystemBackend.
 *
 * @param config - Manifest filesystem config. Undefined/absent defaults to local.
 * @param cwd - Working directory for the local backend. Required when backend is "local".
 * @returns A FileSystemBackend ready for use.
 * @throws On invalid config (e.g., nexus without url).
 */
export function resolveFileSystem(
  config: FileSystemConfig | undefined,
  cwd: string,
): FileSystemBackend {
  const backend = config?.backend ?? "local";

  if (backend === "local") {
    return createLocalFileSystem(cwd);
  }

  // backend === "nexus"
  const validated = validateNexusFileSystemConfig(config?.options ?? {});
  if (!validated.ok) {
    throw new Error(`Invalid nexus filesystem config: ${validated.error.message}`);
  }
  return createNexusFileSystem(validated.value);
}
