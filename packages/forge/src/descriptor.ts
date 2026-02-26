/**
 * BrickDescriptor for @koi/forge.
 *
 * Enables manifest auto-resolution for the forge component provider.
 * Creates a forge runtime that auto-discovers forged artifacts.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";

function validateForgeDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Forge options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for forge component provider.
 *
 * Note: The forge provider requires a ForgeStore and TieredSandboxExecutor
 * that cannot be resolved from YAML alone. The factory throws — the CLI
 * must inject runtime dependencies after resolution. This descriptor
 * registers the name/alias so the resolver can validate and locate it.
 */
export const descriptor: BrickDescriptor<unknown> = {
  kind: "forge",
  name: "@koi/forge",
  aliases: ["forge"],
  optionsValidator: validateForgeDescriptorOptions,
  factory(): unknown {
    throw new Error(
      "@koi/forge requires a ForgeStore and TieredSandboxExecutor. " +
        "Use createForgeComponentProvider(config) directly from the CLI.",
    );
  },
};
