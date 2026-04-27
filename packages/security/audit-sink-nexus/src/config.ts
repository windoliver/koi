import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusAuditSinkConfig {
  readonly transport: NexusTransport;
  readonly basePath?: string | undefined;
  readonly batchSize?: number | undefined;
  readonly flushIntervalMs?: number | undefined;
}

export const DEFAULT_BASE_PATH = "koi/audit";
export const DEFAULT_BATCH_SIZE = 20;
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

export function validateNexusAuditSinkConfig(raw: unknown): Result<NexusAuditSinkConfig, KoiError> {
  if (raw === null || typeof raw !== "object") {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config must be a non-null object", retryable: false },
    };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.transport !== "object" || obj.transport === null) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config.transport must be provided", retryable: false },
    };
  }
  if (obj.batchSize !== undefined && (typeof obj.batchSize !== "number" || obj.batchSize < 1)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "config.batchSize must be a positive number",
        retryable: false,
      },
    };
  }
  return { ok: true, value: raw as NexusAuditSinkConfig };
}
