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
  return {
    from: msg.from as string,
    to: msg.to as string,
    kind: KOI_TO_NEXUS[msg.kind],
    ...(msg.correlationId !== undefined ? { correlationId: msg.correlationId as string } : {}),
    ...(msg.ttlSeconds !== undefined ? { ttlSeconds: msg.ttlSeconds } : {}),
    type: msg.type,
    payload: msg.payload as Record<string, unknown>,
    ...(msg.metadata !== undefined ? { metadata: msg.metadata as Record<string, unknown> } : {}),
  };
}

/** Map a Nexus message envelope to a Koi AgentMessage. Returns undefined for unknown kinds. */
export function mapNexusToKoi(envelope: NexusMessageEnvelope): AgentMessage | undefined {
  const kind = NEXUS_TO_KOI[envelope.kind];
  if (kind === undefined) return undefined;

  return {
    id: messageId(envelope.id),
    from: agentId(envelope.from),
    to: agentId(envelope.to),
    kind,
    ...(envelope.correlationId !== undefined
      ? { correlationId: messageId(envelope.correlationId) }
      : {}),
    createdAt: envelope.createdAt,
    ...(envelope.ttlSeconds !== undefined ? { ttlSeconds: envelope.ttlSeconds } : {}),
    type: envelope.type,
    payload: envelope.payload as JsonObject,
    ...(envelope.metadata !== undefined ? { metadata: envelope.metadata as JsonObject } : {}),
  };
}
