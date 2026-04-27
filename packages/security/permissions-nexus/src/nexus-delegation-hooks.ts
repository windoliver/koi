import type { DelegationGrant, DelegationId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type { RelationshipTuple } from "./types.js";

export interface NexusDelegationHooksConfig {
  readonly transport: NexusTransport;
  readonly policyPath?: string | undefined;
}

export interface NexusDelegationHooks {
  readonly onGrant: (grant: DelegationGrant) => Promise<void>;
  readonly onRevoke: (grantId: DelegationId, cascade: boolean) => Promise<void>;
}

const DEFAULT_POLICY_PATH = "koi/permissions";

function validateDelegationIdPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`DelegationId contains unsafe path characters: ${id}`);
  }
  return id;
}

function mapGrantToTuples(grant: DelegationGrant): readonly RelationshipTuple[] {
  const allow = grant.scope.permissions.allow ?? [];
  const deny = grant.scope.permissions.deny ?? [];
  const resources = grant.scope.resources;
  const subject = `agent:${grant.delegateeId}`;

  const allowTuples: RelationshipTuple[] =
    resources !== undefined && resources.length > 0
      ? allow.flatMap((permission) =>
          resources.map((resource) => ({ subject, relation: permission, object: resource })),
        )
      : allow.map((permission) => ({
          subject,
          relation: permission,
          object: `delegation:${grant.id}`,
        }));

  // Deny rules grow monotonically through delegation chains and must be preserved
  const denyTuples: RelationshipTuple[] = deny.map((permission) => ({
    subject,
    relation: `deny:${permission}`,
    object: `delegation:${grant.id}`,
  }));

  return [...allowTuples, ...denyTuples];
}

export function createNexusDelegationHooks(
  config: NexusDelegationHooksConfig,
): NexusDelegationHooks {
  const policyPath = config.policyPath ?? DEFAULT_POLICY_PATH;

  const onGrant = async (grant: DelegationGrant): Promise<void> => {
    const tuples = mapGrantToTuples(grant);
    if (tuples.length === 0) return;

    const safePath = validateDelegationIdPath(grant.id);
    const result = await config.transport.call("write", {
      path: `${policyPath}/tuples/${safePath}.json`,
      content: JSON.stringify(tuples),
    });

    if (!result.ok) {
      throw new Error(`Nexus tuple write failed for grant ${grant.id}: ${result.error.message}`, {
        cause: result.error,
      });
    }
  };

  const onRevoke = async (grantId: DelegationId, _cascade: boolean): Promise<void> => {
    const safePath = validateDelegationIdPath(grantId);
    // Best-effort — silently swallow (revocation is the safety operation)
    await config.transport
      .call("delete", { path: `${policyPath}/tuples/${safePath}.json` })
      .catch(() => {});
  };

  return { onGrant, onRevoke };
}
