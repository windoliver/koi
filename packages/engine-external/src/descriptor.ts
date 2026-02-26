/**
 * BrickDescriptor for @koi/engine-external.
 *
 * Enables manifest auto-resolution for external CLI process engines.
 * Requires a `command` option specifying the external process to run.
 */

import type { EngineAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createExternalAdapter } from "./adapter.js";
import type { ExternalAdapterConfig } from "./types.js";

function validateExternalEngineOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "External engine options must be an object with a 'command' field",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (typeof opts.command !== "string" || opts.command === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "external.command is required and must be a non-empty string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for external engine adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-external",
  aliases: ["external"],
  optionsValidator: validateExternalEngineOptions,
  factory(options): EngineAdapter {
    const command = options.command;
    if (typeof command !== "string") {
      throw new Error("external.command is required");
    }

    const config: ExternalAdapterConfig = {
      command,
      ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
      ...(typeof options.maxOutputBytes === "number"
        ? { maxOutputBytes: options.maxOutputBytes }
        : {}),
    };

    return createExternalAdapter(config);
  },
};
