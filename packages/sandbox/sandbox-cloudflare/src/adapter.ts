/**
 * `EXPERIMENTAL_createCloudflareAdapter` — skeleton entry point.
 *
 * v1 admits ONLY `workloadClass: "A"` (side-effect-free handlers). Other values
 * are rejected with `INVALID_CONFIG` subcode `WORKLOAD_CLASS_NOT_SUPPORTED`.
 *
 * The deploy/invoke flow is NOT yet implemented — every otherwise-valid
 * `create()` returns `UNAVAILABLE / ADAPTER_NOT_IMPLEMENTED`. The factory is
 * exported under an `EXPERIMENTAL_` prefix and gated behind an explicit
 * `experimental: { iAcceptUnstableContract: true }` opt-in to make the
 * design-only nature impossible to miss at the call site. The factory
 * itself fails fast (`INVALID_CONFIG / EXPERIMENTAL_OPT_IN_REQUIRED`) when
 * the flag is absent, so a careless wire-up cannot ship.
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

export interface ExperimentalAdapterFlag {
  readonly iAcceptUnstableContract: true;
}

export const EXPERIMENTAL_createCloudflareAdapter = (
  config: CloudflareAdapterConfig,
  experimental?: ExperimentalAdapterFlag,
): Result<EdgeFunctionAdapter, KoiError> => {
  if (experimental?.iAcceptUnstableContract !== true) {
    return {
      ok: false,
      error: koiError(
        "INVALID_CONFIG",
        "EXPERIMENTAL_createCloudflareAdapter requires { iAcceptUnstableContract: true } — the deploy path is not implemented yet",
        { subcode: "EXPERIMENTAL_OPT_IN_REQUIRED" },
      ),
    };
  }
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
