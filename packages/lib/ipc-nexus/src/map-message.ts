import type { AgentMessage } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import type { NexusEnvelope } from "./types.js";

export function mapNexusEnvelopeToAgentMessage(envelope: NexusEnvelope): AgentMessage {
  return {
    id: messageId(envelope.id),
    from: agentId(envelope.from),
    to: agentId(envelope.to),
    kind: envelope.kind,
    correlationId:
      envelope.correlationId !== undefined ? messageId(envelope.correlationId) : undefined,
    createdAt: envelope.createdAt,
    ttlSeconds: envelope.ttlSeconds,
    type: envelope.type,
    payload: envelope.payload,
    metadata: envelope.metadata,
  };
}
