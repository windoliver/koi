/**
 * Docker-specific error classification.
 */

import type { ClassifiedError } from "@koi/sandbox-cloud-base";
import { classifyCloudError } from "@koi/sandbox-cloud-base";

/** Classify a Docker error, checking Docker-specific patterns first. */
export function classifyDockerError(error: unknown, durationMs: number): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);

  if (/image.*not\s*found/i.test(message) || /no\s*such\s*image/i.test(message)) {
    return { code: "CRASH", message, durationMs };
  }

  if (/cannot\s*connect/i.test(message) || /docker\s*daemon/i.test(message)) {
    return { code: "CRASH", message, durationMs };
  }

  if (/socket.*not\s*found/i.test(message) || /ENOENT.*docker\.sock/i.test(message)) {
    return { code: "CRASH", message, durationMs };
  }

  if (/container.*not\s*running/i.test(message) || /container.*stopped/i.test(message)) {
    return { code: "CRASH", message, durationMs };
  }

  return classifyCloudError(error, durationMs);
}
