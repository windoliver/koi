/**
 * Vercel-specific error classification.
 */

import type { ClassifiedError } from "@koi/sandbox-cloud-base";
import { classifyCloudError } from "@koi/sandbox-cloud-base";

/** Classify a Vercel error, checking Vercel-specific patterns first. */
export function classifyVercelError(error: unknown, durationMs: number): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);

  if (/sandbox.*unavailable/i.test(message) || /microvm.*failed/i.test(message)) {
    return { code: "CRASH", message, durationMs };
  }

  return classifyCloudError(error, durationMs);
}
