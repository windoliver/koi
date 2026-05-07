import type { AgentMessageInput, KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type { NexusEnvelope, NexusInboxResponse } from "./types.js";

export interface NexusMailboxClient {
  readonly send: (message: AgentMessageInput) => Promise<Result<NexusEnvelope, KoiError>>;
  readonly list: (
    agentId: string,
    limit: number,
  ) => Promise<Result<readonly NexusEnvelope[], KoiError>>;
}

export function createNexusMailboxClient(
  transport: NexusTransport,
  prefix: string,
): NexusMailboxClient {
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
      return result.ok ? { ok: true, value: result.value.messages } : result;
    },
  };
}
