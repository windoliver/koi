/**
 * delegation_check tool — verifies a delegated permission before acting.
 *
 * Wraps DelegationManager.verify() + optional PermissionBackend.check()
 * behind a Tool interface for agents to confirm they hold a permission.
 */

import type { AgentId, JsonObject, PermissionBackend, Tool, ToolPolicy } from "@koi/core";
import { delegationId as toDelegationId } from "@koi/core";
import type { DelegationManager } from "../delegation-manager.js";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

interface CheckInput {
  readonly grantId: string;
  readonly permission: string;
  readonly resource?: string;
}

function validateCheckInput(args: JsonObject): CheckInput {
  const grantId = args.grantId;
  if (typeof grantId !== "string" || grantId.length === 0) {
    throw new Error("grantId is required and must be a non-empty string");
  }

  const permission = args.permission;
  if (typeof permission !== "string" || permission.length === 0) {
    throw new Error("permission is required and must be a non-empty string");
  }

  const resource = args.resource !== undefined ? String(args.resource) : undefined;

  return {
    grantId,
    permission,
    ...(resource !== undefined ? { resource } : {}),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDelegationCheckTool(
  manager: DelegationManager,
  permissionBackend: PermissionBackend | undefined,
  ownerAgentId: AgentId,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    origin: "primordial",
    descriptor: {
      name: `${prefix}_check`,
      description: "Check whether a delegated permission is valid. Returns { allowed, reason? }.",
      inputSchema: {
        type: "object",
        properties: {
          grantId: { type: "string", description: "Delegation grant ID to verify" },
          permission: { type: "string", description: "Permission/tool name to check" },
          resource: { type: "string", description: "Optional resource to check against" },
        },
        required: ["grantId", "permission"],
      },
    },
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const input = validateCheckInput(args);

      // Step 1: Verify the grant is valid via DelegationManager
      const verifyResult = await manager.verify(toDelegationId(input.grantId), input.permission);

      if (!verifyResult.ok) {
        return { allowed: false, reason: verifyResult.reason };
      }

      // Step 2: If permissionBackend is available, also check via backend
      if (permissionBackend !== undefined) {
        const decision = await permissionBackend.check({
          principal: `agent:${ownerAgentId}`,
          action: input.permission,
          resource: input.resource ?? `delegation:${input.grantId}`,
        });

        if (decision.effect !== "allow") {
          return {
            allowed: false,
            reason:
              decision.effect === "deny"
                ? decision.reason
                : `requires approval: ${decision.reason}`,
          };
        }
      }

      return { allowed: true };
    },
  };
}
