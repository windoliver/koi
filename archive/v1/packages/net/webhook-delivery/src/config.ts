/**
 * Webhook delivery configuration and validation.
 */

import type { CircuitBreakerConfig, RetryConfig } from "@koi/errors";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG, DEFAULT_RETRY_CONFIG } from "@koi/errors";

export interface WebhookDeliveryConfig {
  /** Maximum concurrent HTTP deliveries. Default: 10. */
  readonly maxConcurrentDeliveries: number;
  /** HTTP request timeout in milliseconds. Default: 10_000. */
  readonly requestTimeoutMs: number;
  /** Maximum retry attempts per delivery. Default: 5. */
  readonly maxRetries: number;
  /** Maximum response body bytes to read for diagnostics. Default: 4096. */
  readonly maxResponseBodyBytes: number;
  /** Retry configuration from @koi/errors. */
  readonly retryConfig: RetryConfig;
  /** Circuit breaker configuration from @koi/errors. */
  readonly circuitBreakerConfig: CircuitBreakerConfig;
}

export const DEFAULT_WEBHOOK_DELIVERY_CONFIG: WebhookDeliveryConfig = {
  maxConcurrentDeliveries: 10,
  requestTimeoutMs: 10_000,
  maxRetries: 5,
  maxResponseBodyBytes: 4096,
  retryConfig: {
    ...DEFAULT_RETRY_CONFIG,
    maxRetries: 5,
    initialDelayMs: 1_000,
    maxBackoffMs: 60_000,
  },
  circuitBreakerConfig: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

export interface WebhookDeliveryConfigError {
  readonly field: string;
  readonly message: string;
}

/**
 * Validates webhook delivery config. Returns list of errors (empty = valid).
 */
export function validateWebhookDeliveryConfig(
  config: Partial<WebhookDeliveryConfig>,
): readonly WebhookDeliveryConfigError[] {
  const errors: WebhookDeliveryConfigError[] = [];

  if (config.maxConcurrentDeliveries !== undefined && config.maxConcurrentDeliveries < 1) {
    errors.push({ field: "maxConcurrentDeliveries", message: "must be >= 1" });
  }
  if (config.requestTimeoutMs !== undefined && config.requestTimeoutMs < 100) {
    errors.push({ field: "requestTimeoutMs", message: "must be >= 100ms" });
  }
  if (config.maxRetries !== undefined && config.maxRetries < 0) {
    errors.push({ field: "maxRetries", message: "must be >= 0" });
  }
  if (config.maxResponseBodyBytes !== undefined && config.maxResponseBodyBytes < 0) {
    errors.push({ field: "maxResponseBodyBytes", message: "must be >= 0" });
  }

  return errors;
}
