/**
 * delegation_grant tool — grants another agent access to resources.
 *
 * Wraps DelegationManager.grant() behind a Tool interface suitable for
 * agent invocation during an agentic loop.
 */

import type { AgentId, JsonObject, Tool, TrustTier } from "@koi/core";
import { agentId as toAgentId } from "@koi/core";
import type { DelegationManager } from "../delegation-manager.js";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

interface GrantInput {
  readonly delegateeId: string;
  readonly permissions: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
  readonly resources?: readonly string[];
  readonly ttlMs?: number;
}

function validateGrantInput(args: JsonObject): GrantInput {
  const delegateeId = args.delegateeId;
  if (typeof delegateeId !== "string" || delegateeId.length === 0) {
    throw new Error("delegateeId is required and must be a non-empty string");
  }

  const permissions = args.permissions;
  if (permissions === null || typeof permissions !== "object") {
    throw new Error("permissions is required and must be an object with allow/deny arrays");
  }

  const perms = permissions as Record<string, unknown>;
  const allow = perms.allow !== undefined ? (perms.allow as readonly string[]) : undefined;
  const deny = perms.deny !== undefined ? (perms.deny as readonly string[]) : undefined;

  const resources =
    args.resources !== undefined ? (args.resources as readonly string[]) : undefined;
  const ttlMs = args.ttlMs !== undefined ? Number(args.ttlMs) : undefined;
  if (ttlMs !== undefined && (Number.isNaN(ttlMs) || ttlMs <= 0)) {
    throw new Error("ttlMs must be a positive number");
  }

  return {
    delegateeId,
    permissions: {
      ...(allow !== undefined ? { allow } : {}),
      ...(deny !== undefined ? { deny } : {}),
    },
    ...(resources !== undefined ? { resources } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDelegationGrantTool(
  manager: DelegationManager,
  ownerAgentId: AgentId,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_grant`,
      description:
        "Grant another agent access to resources. Returns the grant ID and scope details.",
      inputSchema: {
        type: "object",
        properties: {
          delegateeId: { type: "string", description: "Target agent ID to grant access to" },
          permissions: {
            type: "object",
            description: "Tool allow/deny rules",
            properties: {
              allow: { type: "array", items: { type: "string" }, description: "Allowed tools" },
              deny: { type: "array", items: { type: "string" }, description: "Denied tools" },
            },
          },
          resources: {
            type: "array",
            items: { type: "string" },
            description: "Glob resource patterns (e.g., read_file:/workspace/src/**)",
          },
          ttlMs: { type: "number", description: "Grant TTL in milliseconds" },
        },
        required: ["delegateeId", "permissions"],
      },
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const input = validateGrantInput(args);

      const result = await manager.grant(
        ownerAgentId,
        toAgentId(input.delegateeId),
        {
          permissions: input.permissions,
          ...(input.resources !== undefined ? { resources: input.resources } : {}),
        },
        input.ttlMs,
      );

      if (!result.ok) {
        throw new Error(`Grant failed: ${result.error.message}`);
      }

      return {
        grantId: result.value.id,
        scope: result.value.scope,
        expiresAt: result.value.expiresAt,
      };
    },
  };
}
