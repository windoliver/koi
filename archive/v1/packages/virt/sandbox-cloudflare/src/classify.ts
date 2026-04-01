/**
 * Cloudflare-specific error classification.
 */

import type { ClassifiedError } from "@koi/sandbox-cloud-base";
import { classifyCloudError } from "@koi/sandbox-cloud-base";

/** Classify a Cloudflare error. */
export function classifyCloudflareError(error: unknown, durationMs: number): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);

  if (/worker.*limit/i.test(message) || /script.*too\s*large/i.test(message)) {
    return { code: "CRASH", message, durationMs };
  }

  return classifyCloudError(error, durationMs);
}
