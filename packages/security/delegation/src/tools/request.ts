/**
 * delegation_request tool — requests capabilities from another agent.
 *
 * Sends a capability_request message via the Mailbox and blocks until
 * the target agent responds (grant/deny) or the request times out.
 */

import type { AgentId, JsonObject, MailboxComponent, Tool, ToolPolicy } from "@koi/core";
import { agentId as toAgentId } from "@koi/core";
import {
  CAPABILITY_REQUEST_TYPE,
  CAPABILITY_RESPONSE_STATUS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../capability-request-constants.js";
import { waitForResponse } from "../wait-for-response.js";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

interface RequestInput {
  readonly targetAgentId: string;
  readonly permissions: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
  readonly resources?: readonly string[];
  readonly reason: string;
  readonly timeoutMs?: number;
}

function toStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${field} must contain only strings, got ${typeof item}`);
    }
  }
  return value as readonly string[];
}

function validateRequestInput(args: JsonObject): RequestInput {
  const targetAgentId = args.targetAgentId;
  if (typeof targetAgentId !== "string" || targetAgentId.length === 0) {
    throw new Error("targetAgentId is required and must be a non-empty string");
  }

  const permissions = args.permissions;
  if (permissions === null || typeof permissions !== "object") {
    throw new Error("permissions is required and must be an object with allow/deny arrays");
  }

  const perms = permissions as Record<string, unknown>;
  const allow =
    perms.allow !== undefined ? toStringArray(perms.allow, "permissions.allow") : undefined;
  const deny = perms.deny !== undefined ? toStringArray(perms.deny, "permissions.deny") : undefined;

  const reason = args.reason;
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error("reason is required and must be a non-empty string");
  }

  const resources =
    args.resources !== undefined ? toStringArray(args.resources, "resources") : undefined;
  const timeoutMs = args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined;
  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("timeoutMs must be a positive number");
  }

  return {
    targetAgentId,
    permissions: {
      ...(allow !== undefined ? { allow } : {}),
      ...(deny !== undefined ? { deny } : {}),
    },
    reason,
    ...(resources !== undefined ? { resources } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDelegationRequestTool(
  mailbox: MailboxComponent,
  ownerAgentId: AgentId,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_request`,
      description:
        "Request capabilities from another agent. Blocks until the target grants or denies the request, or times out.",
      inputSchema: {
        type: "object",
        properties: {
          targetAgentId: { type: "string", description: "Agent ID to request capabilities from" },
          permissions: {
            type: "object",
            description: "Requested tool allow/deny rules",
            properties: {
              allow: {
                type: "array",
                items: { type: "string" },
                description: "Tools to request access to",
              },
              deny: { type: "array", items: { type: "string" }, description: "Tools to deny" },
            },
          },
          resources: {
            type: "array",
            items: { type: "string" },
            description: "Glob resource patterns (e.g., read_file:/workspace/src/**)",
          },
          reason: { type: "string", description: "Human-readable justification for the request" },
          timeoutMs: {
            type: "number",
            description: "Request timeout in milliseconds (default: 30000)",
          },
        },
        required: ["targetAgentId", "permissions", "reason"],
      },
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const input = validateRequestInput(args);
      const timeout = input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

      const payload: JsonObject = {
        permissions: {
          ...(input.permissions.allow !== undefined ? { allow: input.permissions.allow } : {}),
          ...(input.permissions.deny !== undefined ? { deny: input.permissions.deny } : {}),
        },
        reason: input.reason,
        ...(input.resources !== undefined ? { resources: input.resources } : {}),
      };

      const sendResult = await mailbox.send({
        from: ownerAgentId,
        to: toAgentId(input.targetAgentId),
        kind: "request",
        type: CAPABILITY_REQUEST_TYPE,
        payload,
      });

      if (!sendResult.ok) {
        throw new Error(`Failed to send capability request: ${sendResult.error.message}`);
      }

      const waitResult = await waitForResponse({
        mailbox,
        correlationId: sendResult.value.id,
        timeoutMs: timeout,
      });

      if (!waitResult.ok) {
        return { granted: false, reason: waitResult.reason };
      }

      const responsePayload = waitResult.message.payload;
      if (responsePayload.status === CAPABILITY_RESPONSE_STATUS.GRANTED) {
        return {
          granted: true,
          grantId: responsePayload.grantId,
          scope: responsePayload.scope,
        };
      }

      return {
        granted: false,
        reason: responsePayload.reason ?? "denied",
      };
    },
  };
}
