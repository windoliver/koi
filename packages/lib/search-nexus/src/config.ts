/**
 * Configuration types and validation for the Nexus-backed SearchBackend.
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusSearchConfig {
  /** Pre-configured transport. Caller owns the lifecycle. */
  readonly transport: NexusTransport;
  /** Index name. Default: "koi". */
  readonly indexName?: string | undefined;
  /** Max documents per batch index call. Default: 100. */
  readonly maxBatchSize?: number | undefined;
}

export const DEFAULT_NEXUS_SEARCH_CONFIG = {
  indexName: "koi",
  maxBatchSize: 100,
} as const;

export function validateNexusSearchConfig(
  config: NexusSearchConfig,
): Result<NexusSearchConfig, KoiError> {
  if (config.indexName !== undefined && config.indexName === "") {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "indexName must not be empty", retryable: false },
    };
  }

  const maxBatchSize = config.maxBatchSize ?? DEFAULT_NEXUS_SEARCH_CONFIG.maxBatchSize;
  if (maxBatchSize <= 0) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "maxBatchSize must be positive", retryable: false },
    };
  }

  return { ok: true, value: config };
}
