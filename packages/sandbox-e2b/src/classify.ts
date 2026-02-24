/**
 * E2B-specific error classification.
 */

import type { ClassifiedError } from "@koi/sandbox-cloud-base";
import { classifyCloudError } from "@koi/sandbox-cloud-base";

/** Classify an E2B error, checking E2B-specific patterns first. */
export function classifyE2bError(error: unknown, durationMs: number): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);

  if (/template.*not\s*found/i.test(message) || /sandbox.*not\s*found/i.test(message)) {
    return { code: "CRASH", message, durationMs };
  }

  if (/rate\s*limit/i.test(message) || /too\s*many\s*requests/i.test(message)) {
    return { code: "CRASH", message, durationMs };
  }

  return classifyCloudError(error, durationMs);
}
