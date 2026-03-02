/**
 * Configuration validation for workspace provider.
 *
 * Validates user-supplied config, applies defaults, and returns
 * a Result with the resolved configuration.
 */

import type {
  KoiError,
  ResolvedWorkspaceConfig,
  Result,
  WorkspaceBackend,
  WorkspaceInfo,
} from "@koi/core";
import { DEFAULT_CLEANUP_POLICY, DEFAULT_CLEANUP_TIMEOUT_MS } from "@koi/core";
import type { WorkspaceProviderConfig } from "./types.js";

const VALID_CLEANUP_POLICIES: ReadonlySet<string> = new Set(["always", "on_success", "never"]);

/** Validated output of workspace config validation. */
export interface ValidatedWorkspaceConfig {
  readonly config: ResolvedWorkspaceConfig;
  readonly backend: WorkspaceBackend;
  readonly postCreate?: ((workspace: WorkspaceInfo) => Promise<void>) | undefined;
  readonly pruneStale?: (() => Promise<void>) | undefined;
}

/** Validate workspace provider config, applying defaults for optional fields. */
export function validateWorkspaceConfig(
  raw: WorkspaceProviderConfig,
): Result<ValidatedWorkspaceConfig, KoiError> {
  if (!raw.backend) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "WorkspaceProviderConfig.backend is required",
        retryable: false,
      },
    };
  }

  if (raw.cleanupPolicy !== undefined && !VALID_CLEANUP_POLICIES.has(raw.cleanupPolicy)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid cleanupPolicy "${raw.cleanupPolicy}". Must be one of: always, on_success, never`,
        retryable: false,
      },
    };
  }

  if (
    raw.cleanupTimeoutMs !== undefined &&
    (raw.cleanupTimeoutMs <= 0 || !Number.isFinite(raw.cleanupTimeoutMs))
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `cleanupTimeoutMs must be a positive finite number, got ${raw.cleanupTimeoutMs}`,
        retryable: false,
      },
    };
  }

  if (raw.requireSandbox === true && !raw.backend.isSandboxed) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `requireSandbox is enabled but backend '${raw.backend.name}' does not provide container isolation`,
        retryable: false,
      },
    };
  }

  return {
    ok: true,
    value: {
      config: {
        cleanupPolicy: raw.cleanupPolicy ?? DEFAULT_CLEANUP_POLICY,
        cleanupTimeoutMs: raw.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      },
      backend: raw.backend,
      postCreate: raw.postCreate,
      pruneStale: raw.pruneStale,
    },
  };
}
