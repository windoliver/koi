/**
 * Forge error types — discriminated union with per-stage variants.
 */

// ---------------------------------------------------------------------------
// Test failure detail
// ---------------------------------------------------------------------------

export interface TestFailure {
  readonly testName: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// ForgeError discriminated union
// ---------------------------------------------------------------------------

export type ForgeError =
  | {
      readonly stage: "static";
      readonly code:
        | "INVALID_SCHEMA"
        | "INVALID_NAME"
        | "SIZE_EXCEEDED"
        | "MISSING_FIELD"
        | "INVALID_TYPE"
        | "MANIFEST_PARSE_FAILED";
      readonly message: string;
    }
  | {
      readonly stage: "sandbox";
      readonly code: "TIMEOUT" | "OOM" | "CRASH" | "PERMISSION";
      readonly message: string;
      readonly durationMs?: number;
    }
  | {
      readonly stage: "self_test";
      readonly code: "TEST_FAILED" | "VERIFIER_REJECTED";
      readonly message: string;
      readonly failures?: readonly TestFailure[];
    }
  | {
      readonly stage: "trust";
      readonly code: "GOVERNANCE_REJECTED" | "RATE_LIMITED" | "DEPTH_EXCEEDED";
      readonly message: string;
    }
  | {
      readonly stage: "governance";
      readonly code:
        | "FORGE_DISABLED"
        | "MAX_DEPTH"
        | "MAX_SESSION_FORGES"
        | "SCOPE_VIOLATION"
        | "DEPTH_TOOL_RESTRICTED";
      readonly message: string;
    }
  | {
      readonly stage: "store";
      readonly code: "SAVE_FAILED" | "LOAD_FAILED" | "SEARCH_FAILED";
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function staticError(
  code: Extract<ForgeError, { readonly stage: "static" }>["code"],
  message: string,
): ForgeError {
  return { stage: "static", code, message };
}

export function typeError(message: string): ForgeError {
  return { stage: "static", code: "INVALID_TYPE", message };
}

export function sandboxError(
  code: Extract<ForgeError, { readonly stage: "sandbox" }>["code"],
  message: string,
  durationMs?: number,
): ForgeError {
  return durationMs !== undefined
    ? { stage: "sandbox", code, message, durationMs }
    : { stage: "sandbox", code, message };
}

export function selfTestError(
  code: Extract<ForgeError, { readonly stage: "self_test" }>["code"],
  message: string,
  failures?: readonly TestFailure[],
): ForgeError {
  return failures !== undefined
    ? { stage: "self_test", code, message, failures }
    : { stage: "self_test", code, message };
}

export function trustError(
  code: Extract<ForgeError, { readonly stage: "trust" }>["code"],
  message: string,
): ForgeError {
  return { stage: "trust", code, message };
}

export function governanceError(
  code: Extract<ForgeError, { readonly stage: "governance" }>["code"],
  message: string,
): ForgeError {
  return { stage: "governance", code, message };
}

export function storeError(
  code: Extract<ForgeError, { readonly stage: "store" }>["code"],
  message: string,
): ForgeError {
  return { stage: "store", code, message };
}
