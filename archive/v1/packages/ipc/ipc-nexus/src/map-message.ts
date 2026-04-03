/**
 * Bidirectional mapping between Koi AgentMessage and Nexus wire types.
 *
 * Nexus uses "type" (not "kind") with values: task/response/event/cancel.
 * Koi uses "kind" with values: request/response/event/cancel.
 *
 * The only asymmetry: Koi "request" ↔ Nexus "task".
 */

import type { AgentMessage, AgentMessageInput, JsonObject, MessageKind } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import type { NexusMessageEnvelope, NexusSendRequest, NexusSendResponse } from "./nexus-client.js";

// ---------------------------------------------------------------------------
// Type mapping constants
// ---------------------------------------------------------------------------

/** Map Koi MessageKind → Nexus type string. */
const KOI_TO_NEXUS = {
  request: "task",
  response: "response",
  event: "event",
  cancel: "cancel",
} as const satisfies Record<MessageKind, string>;

/** Map Nexus type string → Koi MessageKind. */
const NEXUS_TO_KOI: Readonly<Record<string, MessageKind>> = {
  task: "request",
  response: "response",
  event: "event",
  cancel: "cancel",
} as const;

// ---------------------------------------------------------------------------
// Koi → Nexus (outbound)
// ---------------------------------------------------------------------------

/** Map a Koi AgentMessageInput to a Nexus send request. */
export function mapKoiToNexus(msg: AgentMessageInput): NexusSendRequest {
  const nexusType = KOI_TO_NEXUS[msg.kind];

  // Nexus `type` is the envelope-level classification (task/response/event/cancel).
  // Koi `msg.type` (e.g., "task.completed") is a sub-classification that goes
  // in the payload as `subType` to survive the round-trip.
  return {
    sender: msg.from as string,
    recipient: msg.to as string,
    type: nexusType,
    payload: {
      ...(msg.payload as Record<string, unknown>),
      ...(msg.type !== msg.kind ? { subType: msg.type } : {}),
      ...(msg.metadata !== undefined ? { _metadata: msg.metadata } : {}),
    },
    ...(msg.correlationId !== undefined ? { correlation_id: msg.correlationId as string } : {}),
    ...(msg.ttlSeconds !== undefined ? { ttl_seconds: msg.ttlSeconds } : {}),
  };
}

// ---------------------------------------------------------------------------
// Nexus → Koi (inbound: on-disk envelope)
// ---------------------------------------------------------------------------

/** Map a Nexus on-disk message envelope to a Koi AgentMessage. Returns undefined for unknown types. */
export function mapNexusToKoi(envelope: NexusMessageEnvelope): AgentMessage | undefined {
  const kind = NEXUS_TO_KOI[envelope.type];
  if (kind === undefined) return undefined;

  // Extract subType and _metadata from payload (put there by mapKoiToNexus)
  const { subType, _metadata, ...restPayload } = envelope.payload as Record<string, unknown>;

  return {
    id: messageId(envelope.id),
    from: agentId(envelope.from),
    to: agentId(envelope.to),
    kind,
    ...(envelope.correlation_id !== undefined
      ? { correlationId: messageId(envelope.correlation_id) }
      : {}),
    createdAt: envelope.timestamp ?? new Date().toISOString(),
    ...(envelope.ttl_seconds !== undefined ? { ttlSeconds: envelope.ttl_seconds } : {}),
    type: typeof subType === "string" ? subType : envelope.type,
    payload: restPayload as JsonObject,
    ...(typeof _metadata === "object" && _metadata !== null
      ? { metadata: _metadata as JsonObject }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Nexus → Koi (send response — partial envelope)
// ---------------------------------------------------------------------------

/**
 * Map a Nexus send response to a Koi AgentMessage.
 *
 * The send response is a subset of the full envelope (message_id, path,
 * sender, recipient, type) — no payload, timestamp, or correlation_id.
 * We reconstruct the full AgentMessage using the original input.
 */
export function mapSendResponseToKoi(
  response: NexusSendResponse,
  originalInput: AgentMessageInput,
): AgentMessage {
  return {
    id: messageId(response.message_id),
    from: agentId(response.sender),
    to: agentId(response.recipient),
    kind: originalInput.kind,
    type: originalInput.type,
    payload: originalInput.payload,
    createdAt: new Date().toISOString(),
    ...(originalInput.correlationId !== undefined
      ? { correlationId: originalInput.correlationId }
      : {}),
    ...(originalInput.ttlSeconds !== undefined ? { ttlSeconds: originalInput.ttlSeconds } : {}),
    ...(originalInput.metadata !== undefined ? { metadata: originalInput.metadata } : {}),
  };
}
