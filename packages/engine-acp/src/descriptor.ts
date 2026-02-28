/**
 * BrickDescriptor for @koi/engine-acp.
 *
 * Enables manifest-based auto-resolution for ACP-compatible agents.
 * Requires a `command` field in the engine options.
 */

import type { EngineAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createAcpAdapter } from "./adapter.js";
import type { AcpAdapterConfig } from "./types.js";

function validateAcpEngineOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "ACP engine options must be an object with a 'command' field",
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
        message: "acp.command is required and must be a non-empty string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for the ACP engine adapter.
 * Registered under the name "@koi/engine-acp" with alias "acp".
 */
export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-acp",
  aliases: ["acp"],
  optionsValidator: validateAcpEngineOptions,
  factory(options): EngineAdapter {
    const command = options.command;
    if (typeof command !== "string") {
      throw new Error("acp.command is required");
    }

    const config: AcpAdapterConfig = {
      command,
      ...(Array.isArray(options.args) ? { args: options.args as readonly string[] } : {}),
      ...(typeof options.cwd === "string" ? { cwd: options.cwd } : {}),
      ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
    };

    return createAcpAdapter(config);
  },
};
