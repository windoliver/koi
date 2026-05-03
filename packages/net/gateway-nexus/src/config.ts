/**
 * Configuration for the Nexus-backed gateway SessionStore.
 */

import type { KoiError, Result } from "@koi/core";
import { validation } from "@koi/core";

export interface DegradationConfig {
  /** Number of consecutive failures before entering degraded mode. Default: 3. */
  readonly failureThreshold: number;
  /** How often (ms) to probe Nexus when degraded. Default: 10_000. */
  readonly probeIntervalMs: number;
}

export interface WriteQueueConfig {
  /** Maximum entries in the coalescing queue. Default: 1_000. */
  readonly maxQueueSize: number;
  /** Flush interval in ms. Default: 500. */
  readonly flushIntervalMs: number;
}

export interface GatewayNexusConfig {
  /** Unique identifier for this gateway instance. Default: crypto.randomUUID(). */
  readonly instanceId?: string | undefined;
  /** Nexus path prefix for session records. Default: "global/gateway/sessions". */
  readonly basePath?: string | undefined;
  readonly degradation?: Partial<DegradationConfig> | undefined;
  readonly writeQueue?: Partial<WriteQueueConfig> | undefined;
}

export const DEFAULT_DEGRADATION_CONFIG: DegradationConfig = {
  failureThreshold: 3,
  probeIntervalMs: 10_000,
} as const;

export const DEFAULT_WRITE_QUEUE_CONFIG: WriteQueueConfig = {
  maxQueueSize: 1_000,
  flushIntervalMs: 500,
} as const;

export const DEFAULT_BASE_PATH = "global/gateway/sessions" as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: explicit reject of ASCII control + DEL
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function validateGatewayNexusConfig(config: GatewayNexusConfig): Result<void, KoiError> {
  if (config.basePath !== undefined) {
    if (config.basePath === "") {
      return { ok: false, error: validation("basePath must not be empty") };
    }
    // Reject traversal, absolute paths, and control characters so a hostile
    // operator cannot escape the gateway namespace inside Nexus.
    if (
      config.basePath.includes("..") ||
      config.basePath.startsWith("/") ||
      CONTROL_CHARS.test(config.basePath)
    ) {
      return {
        ok: false,
        error: validation(
          "basePath must not contain '..', start with '/', or contain control characters",
        ),
      };
    }
  }
  if (config.instanceId !== undefined && config.instanceId === "") {
    return { ok: false, error: validation("instanceId must not be empty") };
  }
  const dThresh = config.degradation?.failureThreshold;
  if (dThresh !== undefined && dThresh < 1) {
    return { ok: false, error: validation("degradation.failureThreshold must be >= 1") };
  }
  const wMax = config.writeQueue?.maxQueueSize;
  if (wMax !== undefined && wMax < 1) {
    return { ok: false, error: validation("writeQueue.maxQueueSize must be >= 1") };
  }
  return { ok: true, value: undefined };
}
