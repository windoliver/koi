/**
 * BrickDescriptor for @koi/engine-loop.
 *
 * Enables manifest auto-resolution for the pure TypeScript ReAct loop engine.
 */

import type { EngineAdapter, KoiError, Result } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";

function validateLoopEngineOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Loop engine options must be an object",
        retryable: false,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for loop engine adapter.
 *
 * Note: The loop adapter requires a modelCall handler that cannot be
 * resolved from YAML alone. The factory throws — the CLI must inject
 * model/tool handlers after resolution. This descriptor registers the
 * name/alias so the resolver can validate and locate it.
 */
export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-loop",
  aliases: ["loop"],
  optionsValidator: validateLoopEngineOptions,
  factory(): EngineAdapter {
    throw new Error(
      "@koi/engine-loop requires a modelCall handler. " +
        "Use createLoopAdapter(config) directly from the CLI.",
    );
  },
};
