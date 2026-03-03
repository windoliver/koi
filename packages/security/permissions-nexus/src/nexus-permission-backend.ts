/**
 * Nexus permission backend — thin client that delegates all permission
 * decisions to the Nexus ReBAC server.
 *
 * Nexus handles glob matching, caching, and graph traversal.
 * This client just forwards the query and maps the response.
 * Fail-closed: any error → deny.
 */

import type {
  DelegationGrant,
  KoiError,
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
  Result,
} from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import type { NexusCheckBatchResponse, NexusCheckResponse, RelationshipTuple } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusPermissionBackendConfig {
  readonly client: NexusClient;
}

// ---------------------------------------------------------------------------
// Extended return type (superset of PermissionBackend with grant RPC)
// ---------------------------------------------------------------------------

/** PermissionBackend + ReBAC tuple management. */
export interface NexusPermissionBackend extends PermissionBackend {
  readonly grant: (tuple: RelationshipTuple) => Promise<Result<void, KoiError>>;
  readonly delete: (tuple: RelationshipTuple) => Promise<Result<void, KoiError>>;
  readonly batchWrite: (
    writes: ReadonlyArray<{
      readonly tuple: RelationshipTuple;
      readonly operation: "write" | "delete";
    }>,
  ) => Promise<Result<void, KoiError>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNexusPermissionBackend(
  config: NexusPermissionBackendConfig,
): NexusPermissionBackend {
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

  const grant = async (tuple: RelationshipTuple): Promise<Result<void, KoiError>> => {
    const result = await config.client.rpc<void>("permissions.grant", {
      subject: tuple.subject,
      relation: tuple.relation,
      object: tuple.object,
    });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true, value: undefined };
  };

  const deleteTuple = async (tuple: RelationshipTuple): Promise<Result<void, KoiError>> => {
    const result = await config.client.rpc<void>("permissions.delete", {
      subject: tuple.subject,
      relation: tuple.relation,
      object: tuple.object,
    });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true, value: undefined };
  };

  const batchWrite = async (
    writes: ReadonlyArray<{
      readonly tuple: RelationshipTuple;
      readonly operation: "write" | "delete";
    }>,
  ): Promise<Result<void, KoiError>> => {
    const result = await config.client.rpc<void>("permissions.batchWrite", {
      writes: writes.map((w) => ({
        subject: w.tuple.subject,
        relation: w.tuple.relation,
        object: w.tuple.object,
        operation: w.operation,
      })),
    });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true, value: undefined };
  };

  return { check, checkBatch, grant, delete: deleteTuple, batchWrite };
}

// ---------------------------------------------------------------------------
// Grant → tuple mapping
// ---------------------------------------------------------------------------

/**
 * Maps a DelegationGrant to Zanzibar-style relationship tuples for Nexus sync.
 *
 * Each allowed permission in the grant scope produces a tuple:
 *   subject: "agent:<delegateeId>"
 *   relation: the permission name (e.g., "read_file")
 *   object: "delegation:<grantId>"
 *
 * If the grant has resource patterns, each (permission, resource) pair
 * produces a separate tuple.
 */
export function mapGrantToTuples(grant: DelegationGrant): readonly RelationshipTuple[] {
  const permissions = grant.scope.permissions.allow ?? [];
  const resources = grant.scope.resources;
  const subject = `agent:${grant.delegateeId}`;

  if (resources !== undefined && resources.length > 0) {
    return permissions.flatMap((permission) =>
      resources.map((resource) => ({
        subject,
        relation: permission,
        object: resource,
      })),
    );
  }

  return permissions.map((permission) => ({
    subject,
    relation: permission,
    object: `delegation:${grant.id}`,
  }));
}
