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

function mapGrantToTuples(grant: DelegationGrant): readonly RelationshipTuple[] {
  const permissions = grant.scope.permissions.allow ?? [];
  const resources = grant.scope.resources;
  const subject = `agent:${grant.delegateeId}`;

  if (resources !== undefined && resources.length > 0) {
    return permissions.flatMap((permission) =>
      resources.map((resource) => ({ subject, relation: permission, object: resource })),
    );
  }
  return permissions.map((permission) => ({
    subject,
    relation: permission,
    object: `delegation:${grant.id}`,
  }));
}

export function createNexusDelegationHooks(
  config: NexusDelegationHooksConfig,
): NexusDelegationHooks {
  const policyPath = config.policyPath ?? DEFAULT_POLICY_PATH;

  const onGrant = async (grant: DelegationGrant): Promise<void> => {
    const tuples = mapGrantToTuples(grant);
    if (tuples.length === 0) return;

    const result = await config.transport.call("write", {
      path: `${policyPath}/tuples/${grant.id}.json`,
      content: JSON.stringify(tuples),
    });

    if (!result.ok) {
      throw new Error(`Nexus tuple write failed for grant ${grant.id}: ${result.error.message}`, {
        cause: result.error,
      });
    }
  };

  const onRevoke = async (grantId: DelegationId, _cascade: boolean): Promise<void> => {
    // Best-effort — silently swallow (revocation is the safety operation)
    await config.transport
      .call("delete", { path: `${policyPath}/tuples/${grantId}.json` })
      .catch(() => {});
  };

  return { onGrant, onRevoke };
}
