/**
 * delegation_revoke tool — revoke a previously granted delegation.
 *
 * Wraps DelegationManager.revoke() behind a Tool interface.
 */

import type { JsonObject, Tool, TrustTier } from "@koi/core";
import { delegationId } from "@koi/core";
import type { DelegationManager } from "../delegation-manager.js";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

interface RevokeInput {
  readonly grantId: string;
  readonly cascade: boolean;
}

function validateRevokeInput(args: JsonObject): RevokeInput {
  const grantId = args.grantId;
  if (typeof grantId !== "string" || grantId.length === 0) {
    throw new Error("grantId is required and must be a non-empty string");
  }

  const cascade = typeof args.cascade === "boolean" ? args.cascade : false;

  return { grantId, cascade };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDelegationRevokeTool(
  manager: DelegationManager,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_revoke`,
      description: "Revoke a previously granted delegation. Optionally cascade to children.",
      inputSchema: {
        type: "object",
        properties: {
          grantId: { type: "string", description: "ID of the grant to revoke" },
          cascade: {
            type: "boolean",
            description: "Whether to cascade revocation to child grants (default: false)",
          },
        },
        required: ["grantId"],
      },
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const input = validateRevokeInput(args);
      const revokedIds = await manager.revoke(delegationId(input.grantId), input.cascade);
      return { revokedIds };
    },
  };
}
