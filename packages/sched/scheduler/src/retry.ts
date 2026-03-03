/**
 * Exponential backoff retry delay calculation.
 *
 * Formula: min(maxDelay, baseDelay * 2^attempt) + random(0, jitter)
 * Pure function, no side effects.
 */

import type { SchedulerConfig } from "@koi/core";

export function computeRetryDelay(
  attempt: number,
  config: Pick<SchedulerConfig, "baseRetryDelayMs" | "maxRetryDelayMs" | "retryJitterMs">,
): number {
  const exponential = Math.min(config.maxRetryDelayMs, config.baseRetryDelayMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * config.retryJitterMs);
  return exponential + jitter;
}
