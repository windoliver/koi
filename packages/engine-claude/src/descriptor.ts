/**
 * BrickDescriptor for @koi/engine-claude.
 *
 * Enables manifest auto-resolution for the Claude Agent SDK engine.
 * Requires ANTHROPIC_API_KEY environment variable.
 */

import type { EngineAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";

function validateClaudeEngineOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Claude engine options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for Claude engine adapter.
 *
 * Note: The Claude adapter requires SDK function bindings that cannot be
 * resolved from YAML alone. The factory throws — the CLI must inject SDK
 * bindings after resolution. This descriptor registers the name/alias so
 * the resolver can validate and locate it.
 */
export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-claude",
  aliases: ["claude"],
  optionsValidator: validateClaudeEngineOptions,
  factory(_options, _context: ResolutionContext): EngineAdapter {
    throw new Error(
      "@koi/engine-claude requires SDK function bindings. " +
        "Use createClaudeAdapter(config, sdk) directly from the CLI.",
    );
  },
};
