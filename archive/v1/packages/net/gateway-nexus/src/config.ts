/**
 * Configuration for Nexus-backed gateway state stores.
 */

import type { KoiError, Result } from "@koi/core";
import { validation } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export interface PollingConfig {
  /** Node registry polling interval in ms. Default: 5_000. */
  readonly nodeIntervalMs: number;
  /** Session store polling interval in ms. Default: 30_000. */
  readonly sessionIntervalMs: number;
  /** Surface store polling interval in ms. Default: 60_000. */
  readonly surfaceIntervalMs: number;
}

export interface GatewayNexusConfig {
  readonly nexusUrl: string;
  readonly apiKey: string;
  /** Unique identifier for this gateway instance. Default: crypto.randomUUID(). */
  readonly instanceId?: string | undefined;
  /** Injectable fetch for testing/tracing. Default: globalThis.fetch. */
  readonly fetch?:
    | typeof globalThis.fetch
    | ((input: Request | string | URL, init?: RequestInit) => Promise<Response>)
    | undefined;
  /** Request timeout in ms. Default: 10_000. */
  readonly timeoutMs?: number | undefined;
  readonly degradation?: Partial<DegradationConfig> | undefined;
  readonly writeQueue?: Partial<WriteQueueConfig> | undefined;
  readonly polling?: Partial<PollingConfig> | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_DEGRADATION_CONFIG: DegradationConfig = {
  failureThreshold: 3,
  probeIntervalMs: 10_000,
} as const;

export const DEFAULT_WRITE_QUEUE_CONFIG: WriteQueueConfig = {
  maxQueueSize: 1_000,
  flushIntervalMs: 500,
} as const;

export const DEFAULT_POLLING_CONFIG: PollingConfig = {
  nodeIntervalMs: 5_000,
  sessionIntervalMs: 30_000,
  surfaceIntervalMs: 60_000,
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateGatewayNexusConfig(config: GatewayNexusConfig): Result<void, KoiError> {
  if (config.nexusUrl === "") {
    return { ok: false, error: validation("nexusUrl must not be empty") };
  }
  if (config.apiKey === "") {
    return { ok: false, error: validation("apiKey must not be empty") };
  }
  return { ok: true, value: undefined };
}
