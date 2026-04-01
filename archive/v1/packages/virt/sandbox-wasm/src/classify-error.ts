/**
 * Maps QuickJS error objects to the L0 SandboxErrorCode taxonomy.
 *
 * QuickJS errors are dumped as plain objects with { name, message, stack }.
 * The interrupt handler produces "InternalError: interrupted" for timeouts.
 * Memory limit violations produce "InternalError: out of memory".
 * Everything else (SyntaxError, TypeError, user throws) maps to CRASH.
 */

import type { SandboxErrorCode } from "@koi/core";

interface QuickJSDumpedError {
  readonly name?: string;
  readonly message?: string;
  readonly stack?: string;
}

function isErrorObject(value: unknown): value is QuickJSDumpedError {
  return typeof value === "object" && value !== null && "message" in value;
}

export function classifyError(
  dumped: unknown,
  durationMs: number,
): { readonly code: SandboxErrorCode; readonly message: string; readonly durationMs: number } {
  if (!isErrorObject(dumped)) {
    const message = typeof dumped === "string" ? dumped : String(dumped);
    return { code: "CRASH", message, durationMs };
  }

  const message = dumped.message ?? "Unknown error";

  if (dumped.name === "InternalError" && message === "interrupted") {
    return { code: "TIMEOUT", message, durationMs };
  }

  if (dumped.name === "InternalError" && message.includes("out of memory")) {
    return { code: "OOM", message, durationMs };
  }

  return { code: "CRASH", message, durationMs };
}
