/**
 * Error helpers for manifest resolution.
 */

import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { ResolutionFailure } from "./types.js";

/**
 * Aggregates multiple resolution failures into a single KoiError.
 */
export function aggregateErrors(failures: readonly ResolutionFailure[]): KoiError {
  const lines = failures.map((f) => {
    const loc = f.index !== undefined ? `[${f.index}]` : "";
    return `  ${f.section}${loc} "${f.name}": ${f.error.message}`;
  });

  return {
    code: "VALIDATION",
    message: `Manifest resolution failed with ${failures.length} error(s):\n${lines.join("\n")}`,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    context: {
      failures: failures.map((f) => ({
        section: f.section,
        index: f.index,
        name: f.name,
        code: f.error.code,
        message: f.error.message,
      })),
    },
  };
}

/**
 * Formats a resolution error for CLI stderr output.
 */
export function formatResolutionError(error: KoiError): string {
  return `Resolution error: ${error.message}\n`;
}
