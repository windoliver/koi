/**
 * Nexus permission backend — thin client that delegates all permission
 * decisions to the Nexus ReBAC server.
 *
 * Nexus handles glob matching, caching, and graph traversal.
 * This client just forwards the query and maps the response.
 * Fail-closed: any error → deny.
 */

import type {
  KoiError,
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
  Result,
} from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import type { NexusCheckBatchResponse, NexusCheckResponse } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusPermissionBackendConfig {
  readonly client: NexusClient;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNexusPermissionBackend(
  config: NexusPermissionBackendConfig,
): PermissionBackend {
  const check = async (query: PermissionQuery): Promise<PermissionDecision> => {
    const result: Result<NexusCheckResponse, KoiError> =
      await config.client.rpc<NexusCheckResponse>("permissions.check", {
        principal: query.principal,
        action: query.action,
        resource: query.resource,
        ...(query.context !== undefined ? { context: query.context } : {}),
      });

    if (!result.ok) {
      return { effect: "deny", reason: `Nexus error: ${result.error.message}` };
    }

    return result.value.allowed
      ? { effect: "allow" }
      : { effect: "deny", reason: result.value.reason ?? "denied by Nexus" };
  };

  const checkBatch = async (
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionDecision[]> => {
    const result = await config.client.rpc<NexusCheckBatchResponse>("permissions.checkBatch", {
      queries: queries.map((q) => ({
        principal: q.principal,
        action: q.action,
        resource: q.resource,
        ...(q.context !== undefined ? { context: q.context } : {}),
      })),
    });

    if (!result.ok) {
      const deny: PermissionDecision = {
        effect: "deny",
        reason: `Nexus error: ${result.error.message}`,
      };
      return queries.map(() => deny);
    }

    return result.value.results.map((r) =>
      r.allowed
        ? { effect: "allow" as const }
        : { effect: "deny" as const, reason: r.reason ?? "denied by Nexus" },
    );
  };

  return { check, checkBatch };
}
