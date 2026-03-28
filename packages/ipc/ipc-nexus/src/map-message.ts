/**
 * Bidirectional mapping between Koi AgentMessage and Nexus wire envelope.
 */

import type { AgentMessage, AgentMessageInput, JsonObject, MessageKind } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import type { NexusMessageEnvelope, NexusSendRequest } from "./nexus-client.js";

// ---------------------------------------------------------------------------
// Kind mapping constants
// ---------------------------------------------------------------------------

const KOI_TO_NEXUS = {
  request: "task",
  response: "response",
  event: "event",
  cancel: "cancel",
} as const satisfies Record<MessageKind, string>;

const NEXUS_TO_KOI: Readonly<Record<string, MessageKind>> = {
  task: "request",
  response: "response",
  event: "event",
  cancel: "cancel",
} as const;

// ---------------------------------------------------------------------------
// Mapping functions
// ---------------------------------------------------------------------------

/** Map a Koi AgentMessageInput to a Nexus send request. */
export function mapKoiToNexus(msg: AgentMessageInput): NexusSendRequest {
  const nexusKind = KOI_TO_NEXUS[msg.kind];
  return {
    sender: msg.from as string,
    recipient: msg.to as string,
    kind: nexusKind,
    ...(msg.correlationId !== undefined ? { correlationId: msg.correlationId as string } : {}),
    ...(msg.ttlSeconds !== undefined ? { ttlSeconds: msg.ttlSeconds } : {}),
    // Nexus `type` is an enum matching `kind`. The Koi `msg.type` (e.g., "task.completed")
    // is a sub-classification that goes in the payload as `subType`.
    type: nexusKind,
    payload: {
      ...(msg.payload as Record<string, unknown>),
      ...(msg.type !== msg.kind ? { subType: msg.type } : {}),
    },
    ...(msg.metadata !== undefined ? { metadata: msg.metadata as Record<string, unknown> } : {}),
  };
}

/** Map a Nexus message envelope to a Koi AgentMessage. Returns undefined for unknown kinds. */
export function mapNexusToKoi(envelope: NexusMessageEnvelope): AgentMessage | undefined {
  const kind = NEXUS_TO_KOI[envelope.kind];
  if (kind === undefined) return undefined;

  return {
    id: messageId(envelope.id),
    from: agentId(envelope.sender),
    to: agentId(envelope.recipient),
    kind,
    ...(envelope.correlationId !== undefined
      ? { correlationId: messageId(envelope.correlationId) }
      : {}),
    createdAt: envelope.createdAt,
    ...(envelope.ttlSeconds !== undefined ? { ttlSeconds: envelope.ttlSeconds } : {}),
    // Nexus `type` is the kind enum. The Koi sub-type may be in payload.subType.
    type:
      typeof (envelope.payload as Record<string, unknown>).subType === "string"
        ? ((envelope.payload as Record<string, unknown>).subType as string)
        : envelope.type,
    payload: (() => {
      const { subType: _, ...rest } = envelope.payload as Record<string, unknown>;
      return rest as JsonObject;
    })(),
    ...(envelope.metadata !== undefined ? { metadata: envelope.metadata as JsonObject } : {}),
  };
}
