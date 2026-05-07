/**
 * `createVercelAdapter` — skeleton entry point.
 *
 * v1 admits ONLY `workloadClass: "A"`. Like the Cloudflare adapter, this
 * commit ships the contract surface, config validation, KV state machine
 * port, per-pair Ed25519 helpers, and shim templates. The full deploy /
 * invoke flow lands in follow-up commits.
 *
 * Per spec PR 5: this package is DESIGN-ONLY in v1 and is NOT wired into
 * `@koi/runtime`.
 */

import type {
  EdgeFunctionAdapter,
  EdgeFunctionCreateConfig,
  EdgeFunctionInstance,
  KoiError,
  Result,
} from "@koi/core";

import type { VercelAdapterConfig } from "./types.js";
import { validateVercelAdapterConfig } from "./validate.js";

export const VERCEL_ADAPTER_VERSION = "0.1.0-design-only";

const koiError = (
  code: KoiError["code"],
  message: string,
  context?: KoiError["context"],
): KoiError =>
  context === undefined
    ? { code, message, retryable: false }
    : { code, message, retryable: false, context };

export const createVercelAdapter = (
  config: VercelAdapterConfig,
): Result<EdgeFunctionAdapter, KoiError> => {
  const validated = validateVercelAdapterConfig(config);
  if (!validated.ok) return validated;

  const create = async (
    createConfig: EdgeFunctionCreateConfig,
  ): Promise<Result<EdgeFunctionInstance, KoiError>> => {
    if (createConfig.workloadClass !== "A") {
      return {
        ok: false,
        error: koiError(
          "INVALID_CONFIG",
          `workloadClass "${String(createConfig.workloadClass)}" not supported in v1`,
          {
            subcode: "WORKLOAD_CLASS_NOT_SUPPORTED",
            requested: createConfig.workloadClass,
          },
        ),
      };
    }
    if (typeof createConfig.code !== "string" || createConfig.code.length === 0) {
      return {
        ok: false,
        error: koiError("INVALID_CONFIG", "create config requires non-empty `code`"),
      };
    }
    return {
      ok: false,
      error: koiError(
        "UNAVAILABLE",
        "Vercel deploy path is design-only in v1; this commit ships the contract surface only",
        { subcode: "ADAPTER_NOT_IMPLEMENTED" },
      ),
    };
  };

  const adapter: EdgeFunctionAdapter = {
    name: "vercel",
    version: VERCEL_ADAPTER_VERSION,
    create,
  };
  return { ok: true, value: adapter };
};
