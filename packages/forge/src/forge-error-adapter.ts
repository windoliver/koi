/**
 * Adapter: ForgeError → KoiError.
 *
 * Maps each ForgeError stage/code combination to the Koi 8-type error model
 * with appropriate retryability. Used at the boundary between the forge
 * subsystem and the broader Koi engine.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { ForgeError } from "./errors.js";

// ---------------------------------------------------------------------------
// Mapping table: ForgeError stage+code → KoiErrorCode + retryable
// ---------------------------------------------------------------------------

interface ForgeMapping {
  readonly koiCode: KoiErrorCode;
  readonly retryable: boolean;
}

/** Static stage: all schema/parse failures are VALIDATION, non-retryable. */
const STATIC_MAP: Readonly<
  Record<Extract<ForgeError, { readonly stage: "static" }>["code"], ForgeMapping>
> = {
  INVALID_SCHEMA: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
  INVALID_NAME: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
  SIZE_EXCEEDED: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
  MISSING_FIELD: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
  INVALID_TYPE: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
  MANIFEST_PARSE_FAILED: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
  SYNTAX_ERROR: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
  NETWORK_ACCESS_DENIED: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
};

/** Resolve stage: dependency install/audit failures are EXTERNAL or VALIDATION. */
const RESOLVE_MAP: Readonly<
  Record<Extract<ForgeError, { readonly stage: "resolve" }>["code"], ForgeMapping>
> = {
  AUDIT_FAILED: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
  INSTALL_FAILED: { koiCode: "EXTERNAL", retryable: false },
  INSTALL_TIMEOUT: { koiCode: "TIMEOUT", retryable: RETRYABLE_DEFAULTS.TIMEOUT },
  INTEGRITY_MISMATCH: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
  WORKSPACE_FAILED: { koiCode: "INTERNAL", retryable: RETRYABLE_DEFAULTS.INTERNAL },
};

/** Sandbox stage: mixed — TIMEOUT is retryable, others are not. */
const SANDBOX_MAP: Readonly<
  Record<Extract<ForgeError, { readonly stage: "sandbox" }>["code"], ForgeMapping>
> = {
  TIMEOUT: { koiCode: "TIMEOUT", retryable: RETRYABLE_DEFAULTS.TIMEOUT },
  OOM: { koiCode: "EXTERNAL", retryable: false },
  CRASH: { koiCode: "EXTERNAL", retryable: false },
  PERMISSION: { koiCode: "PERMISSION", retryable: RETRYABLE_DEFAULTS.PERMISSION },
};

/** Self-test stage: verification failures are VALIDATION. */
const SELF_TEST_MAP: Readonly<
  Record<Extract<ForgeError, { readonly stage: "self_test" }>["code"], ForgeMapping>
> = {
  TEST_FAILED: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
  VERIFIER_REJECTED: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
};

/** Trust stage: governance rejections are PERMISSION, rate limits are RATE_LIMIT. */
const TRUST_MAP: Readonly<
  Record<Extract<ForgeError, { readonly stage: "trust" }>["code"], ForgeMapping>
> = {
  GOVERNANCE_REJECTED: { koiCode: "PERMISSION", retryable: RETRYABLE_DEFAULTS.PERMISSION },
  RATE_LIMITED: { koiCode: "RATE_LIMIT", retryable: RETRYABLE_DEFAULTS.RATE_LIMIT },
  DEPTH_EXCEEDED: { koiCode: "PERMISSION", retryable: RETRYABLE_DEFAULTS.PERMISSION },
};

/** Governance stage: policy violations are PERMISSION, session limits are RATE_LIMIT. */
const GOVERNANCE_MAP: Readonly<
  Record<Extract<ForgeError, { readonly stage: "governance" }>["code"], ForgeMapping>
> = {
  FORGE_DISABLED: { koiCode: "PERMISSION", retryable: RETRYABLE_DEFAULTS.PERMISSION },
  MAX_DEPTH: { koiCode: "PERMISSION", retryable: RETRYABLE_DEFAULTS.PERMISSION },
  MAX_SESSION_FORGES: { koiCode: "RATE_LIMIT", retryable: RETRYABLE_DEFAULTS.RATE_LIMIT },
  SCOPE_VIOLATION: { koiCode: "PERMISSION", retryable: RETRYABLE_DEFAULTS.PERMISSION },
  TRUST_DEMOTION_NOT_ALLOWED: { koiCode: "PERMISSION", retryable: RETRYABLE_DEFAULTS.PERMISSION },
  LIFECYCLE_INVALID_TRANSITION: { koiCode: "VALIDATION", retryable: RETRYABLE_DEFAULTS.VALIDATION },
  DEPTH_TOOL_RESTRICTED: { koiCode: "PERMISSION", retryable: RETRYABLE_DEFAULTS.PERMISSION },
  MUTATION_PRESSURE_FROZEN: { koiCode: "PERMISSION", retryable: RETRYABLE_DEFAULTS.PERMISSION },
};

/** Format stage: formatting failures are INTERNAL, timeouts are retryable. */
const FORMAT_MAP: Readonly<
  Record<Extract<ForgeError, { readonly stage: "format" }>["code"], ForgeMapping>
> = {
  FORMAT_FAILED: { koiCode: "INTERNAL", retryable: RETRYABLE_DEFAULTS.INTERNAL },
  FORMAT_TIMEOUT: { koiCode: "TIMEOUT", retryable: RETRYABLE_DEFAULTS.TIMEOUT },
};

/** Store stage: persistence failures are INTERNAL. */
const STORE_MAP: Readonly<
  Record<Extract<ForgeError, { readonly stage: "store" }>["code"], ForgeMapping>
> = {
  SAVE_FAILED: { koiCode: "INTERNAL", retryable: RETRYABLE_DEFAULTS.INTERNAL },
  LOAD_FAILED: { koiCode: "INTERNAL", retryable: RETRYABLE_DEFAULTS.INTERNAL },
  SEARCH_FAILED: { koiCode: "INTERNAL", retryable: RETRYABLE_DEFAULTS.INTERNAL },
};

// ---------------------------------------------------------------------------
// Adapter function
// ---------------------------------------------------------------------------

/** Convert a ForgeError to a KoiError. */
export function forgeErrorToKoiError(error: ForgeError): KoiError {
  const mapping = lookupMapping(error);
  return {
    code: mapping.koiCode,
    message: `Forge [${error.stage}/${error.code}]: ${error.message}`,
    retryable: mapping.retryable,
    context: { stage: error.stage, forgeCode: error.code },
  };
}

function lookupMapping(error: ForgeError): ForgeMapping {
  switch (error.stage) {
    case "static":
      return STATIC_MAP[error.code];
    case "resolve":
      return RESOLVE_MAP[error.code];
    case "sandbox":
      return SANDBOX_MAP[error.code];
    case "self_test":
      return SELF_TEST_MAP[error.code];
    case "trust":
      return TRUST_MAP[error.code];
    case "governance":
      return GOVERNANCE_MAP[error.code];
    case "format":
      return FORMAT_MAP[error.code];
    case "store":
      return STORE_MAP[error.code];
    default: {
      const _exhaustive: never = error;
      throw new Error(`Unknown forge error stage: ${(_exhaustive as ForgeError).stage}`);
    }
  }
}
