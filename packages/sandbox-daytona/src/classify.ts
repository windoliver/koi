/**
 * Daytona-specific error classification.
 */

import type { ClassifiedError } from "@koi/sandbox-cloud-base";
import { classifyCloudError } from "@koi/sandbox-cloud-base";

/** Classify a Daytona error. */
export function classifyDaytonaError(error: unknown, durationMs: number): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);

  if (/workspace.*not\s*found/i.test(message) || /sandbox.*not\s*ready/i.test(message)) {
    return { code: "CRASH", message, durationMs };
  }

  return classifyCloudError(error, durationMs);
}
