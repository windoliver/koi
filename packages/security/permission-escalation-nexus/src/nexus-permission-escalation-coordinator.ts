import type { KoiError, PermissionDecision, PermissionRequest, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import {
  validateNexusPermissionEscalationCoordinatorConfig,
  type NexusPermissionEscalationCoordinatorConfig,
} from "./config.js";
import {
  PERMISSION_ESCALATION_DECISION_TYPE,
  PERMISSION_ESCALATION_REQUEST_TYPE,
  type PermissionEscalationDecisionRecord,
  type PermissionEscalationRequestRecord,
} from "./types.js";

interface NexusEnvelope {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "request" | "response" | "event" | "cancel";
  readonly correlationId?: string | undefined;
  readonly createdAt: string;
  readonly ttlSeconds?: number | undefined;
  readonly type: string;
  readonly payload: unknown;
  readonly metadata?: Record<string, unknown> | undefined;
}

interface NexusInboxResponse {
  readonly messages: readonly NexusEnvelope[];
}

interface NexusMailboxClient {
  readonly send: (
    message: Omit<NexusEnvelope, "id" | "createdAt" | "payload"> & {
      readonly payload: Record<string, unknown>;
    },
  ) => Promise<Result<NexusEnvelope, KoiError>>;
  readonly list: (
    agentId: string,
    limit: number,
  ) => Promise<Result<readonly NexusEnvelope[], KoiError>>;
}

function timeoutDecision(): PermissionDecision {
  return { decision: "expired", reason: "permission escalation timed out" };
}

function rejectDecision(reason: string): PermissionDecision {
  return { decision: "rejected", reason };
}

function isInboxResponse(value: unknown): value is NexusInboxResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

function isPermissionRequest(value: unknown): value is PermissionRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<PermissionRequest>;
  return (
    typeof candidate.requestId === "string" &&
    typeof candidate.agentId === "string" &&
    Array.isArray(candidate.requestedGrants) &&
    candidate.requestedGrants.every((grant) => typeof grant === "string") &&
    typeof candidate.purposeStatement === "string" &&
    typeof candidate.expiresAt === "number"
  );
}

function isRequestRecord(value: unknown): value is PermissionEscalationRequestRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<PermissionEscalationRequestRecord>;
  return (
    candidate.kind === PERMISSION_ESCALATION_REQUEST_TYPE &&
    isPermissionRequest(candidate.request) &&
    typeof candidate.workerAgentId === "string" &&
    typeof candidate.coordinatorAgentId === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.expiresAt === "number"
  );
}

function matchesRequestEnvelope(
  message: NexusEnvelope,
  coordinatorAgentId: string,
): message is NexusEnvelope & { readonly payload: PermissionEscalationRequestRecord } {
  return (
    message.kind === "request" &&
    message.type === PERMISSION_ESCALATION_REQUEST_TYPE &&
    message.to === coordinatorAgentId &&
    isRequestRecord(message.payload) &&
    message.from === message.payload.workerAgentId &&
    message.payload.coordinatorAgentId === coordinatorAgentId &&
    message.payload.request.agentId === message.payload.workerAgentId &&
    message.payload.request.requestId.length > 0
  );
}

function createNexusMailboxClient(transport: NexusTransport, prefix: string): NexusMailboxClient {
  return {
    send: async (message) =>
      transport.call<NexusEnvelope>(`${prefix}.send`, {
        from: message.from,
        to: message.to,
        kind: message.kind,
        correlationId: message.correlationId,
        ttlSeconds: message.ttlSeconds,
        type: message.type,
        payload: message.payload,
        metadata: message.metadata,
      }),
    list: async (agentId, limit) => {
      const result = await transport.call<NexusInboxResponse>(`${prefix}.list`, { agentId, limit });
      if (!result.ok) {
        return result;
      }
      if (!isInboxResponse(result.value)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "permission escalation inbox response was malformed",
            retryable: false,
          },
        };
      }
      return { ok: true, value: result.value.messages };
    },
  };
}

export function createNexusPermissionEscalationCoordinator(
  config: NexusPermissionEscalationCoordinatorConfig,
) {
  const validated = validateNexusPermissionEscalationCoordinatorConfig(config);
  if (!validated.ok) {
    throw new Error(validated.error.message);
  }

  const mailbox = createNexusMailboxClient(config.transport, "ipc");
  const clock = config.clock ?? Date.now;
  const seenRequestIds = new Set<string>();

  return {
    async pollOnce(
      resolve: (request: PermissionRequest) => Promise<PermissionDecision>,
    ): Promise<number> {
      const inboxResult = await mailbox.list(String(config.coordinatorAgentId), 50);
      if (!inboxResult.ok) {
        return 0;
      }

      let handled = 0;
      for (const message of inboxResult.value) {
        if (!matchesRequestEnvelope(message, config.coordinatorAgentId)) {
          continue;
        }

        const record = message.payload;
        if (seenRequestIds.has(record.request.requestId)) {
          continue;
        }
        const decision =
          record.expiresAt <= clock()
            ? timeoutDecision()
            : await resolve(record.request).catch((error: unknown) =>
                rejectDecision(
                  error instanceof Error ? error.message : "permission escalation approval failed",
                ),
              );

        const sendResult = await mailbox.send({
          from: config.coordinatorAgentId,
          to: record.workerAgentId,
          kind: "response",
          correlationId: record.request.requestId,
          type: PERMISSION_ESCALATION_DECISION_TYPE,
          payload: {
            requestId: record.request.requestId,
            workerAgentId: record.workerAgentId,
            coordinatorAgentId: config.coordinatorAgentId,
            decision,
            resolvedAt: clock(),
          } satisfies PermissionEscalationDecisionRecord,
        });

        if (sendResult.ok) {
          seenRequestIds.add(record.request.requestId);
          handled += 1;
        }
      }

      return handled;
    },
    dispose(): void {},
  };
}
