import type { KoiError, PermissionBackend, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusPermissionsConfig {
  readonly transport: NexusTransport;
  /** Current local backend — used for all check() calls. */
  readonly localBackend: PermissionBackend;
  /** Serialize current policy to a JSON-storable object. */
  readonly getCurrentPolicy: () => unknown;
  /** Reconstruct a PermissionBackend from a Nexus-loaded policy. */
  readonly rebuildBackend: (policy: unknown) => PermissionBackend;
  /** Poll interval in ms. Default: 30_000. Set 0 to disable. */
  readonly syncIntervalMs?: number | undefined;
  /** Nexus NFS path prefix. Default: "koi/permissions". */
  readonly policyPath?: string | undefined;
}

interface RawConfig {
  readonly transport: unknown;
  readonly localBackend: unknown;
  readonly getCurrentPolicy: unknown;
  readonly rebuildBackend: unknown;
  readonly syncIntervalMs: unknown;
}

export function validateNexusPermissionsConfig(
  raw: unknown,
): Result<NexusPermissionsConfig, KoiError> {
  if (raw === null || typeof raw !== "object") {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config must be a non-null object", retryable: false },
    };
  }
  const obj = raw as RawConfig;

  if (typeof obj.transport !== "object" || obj.transport === null) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config.transport must be provided", retryable: false },
    };
  }
  if (typeof obj.localBackend !== "object" || obj.localBackend === null) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "config.localBackend must be provided",
        retryable: false,
      },
    };
  }
  if (typeof obj.getCurrentPolicy !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "config.getCurrentPolicy must be a function",
        retryable: false,
      },
    };
  }
  if (typeof obj.rebuildBackend !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "config.rebuildBackend must be a function",
        retryable: false,
      },
    };
  }
  if (
    obj.syncIntervalMs !== undefined &&
    (typeof obj.syncIntervalMs !== "number" || obj.syncIntervalMs < 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "config.syncIntervalMs must be a non-negative number",
        retryable: false,
      },
    };
  }

  return { ok: true, value: raw as NexusPermissionsConfig };
}
