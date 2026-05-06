/**
 * `createCloudflareAdapter` — skeleton entry point.
 *
 * v1 admits ONLY `workloadClass: "A"` (side-effect-free handlers). Other values
 * are rejected with `INVALID_CONFIG` subcode `WORKLOAD_CLASS_NOT_SUPPORTED`.
 *
 * The full deploy/invoke flow (two-worker shim, DO claim/wait protocol,
 * attestation, integrity verification) lands in follow-up commits — this
 * commit ships only the contract surface, config validation, and the
 * host-side response mapper plus their unit tests, so the contract is
 * available for downstream wiring.
 */

import type {
  EdgeFunctionAdapter,
  EdgeFunctionCreateConfig,
  EdgeFunctionInstance,
  KoiError,
  Result,
} from "@koi/core";

import type { CloudflareAdapterConfig } from "./types.js";
import { validateCloudflareAdapterConfig } from "./validate.js";

export const CLOUDFLARE_ADAPTER_VERSION = "0.1.0";

const koiError = (
  code: KoiError["code"],
  message: string,
  context?: KoiError["context"],
): KoiError =>
  context === undefined
    ? { code, message, retryable: false }
    : { code, message, retryable: false, context };

export const createCloudflareAdapter = (
  config: CloudflareAdapterConfig,
): Result<EdgeFunctionAdapter, KoiError> => {
  const validated = validateCloudflareAdapterConfig(config);
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
        "Cloudflare deploy path is not yet implemented; this commit ships the contract surface only",
        { subcode: "ADAPTER_NOT_IMPLEMENTED" },
      ),
    };
  };

  const adapter: EdgeFunctionAdapter = {
    name: "cloudflare",
    version: CLOUDFLARE_ADAPTER_VERSION,
    create,
  };
  return { ok: true, value: adapter };
};
