import type { AgentId, AgentMessage, JsonObject, MailboxComponent } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusMailboxConfig {
  readonly agentId: AgentId;
  readonly transport: NexusTransport;
  readonly fallback?: MailboxComponent | undefined;
  readonly inboxMethodPrefix?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly pageSize?: number | undefined;
}

export interface NexusEnvelope {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "request" | "response" | "event" | "cancel";
  readonly correlationId?: string | undefined;
  readonly createdAt: string;
  readonly ttlSeconds?: number | undefined;
  readonly type: string;
  readonly payload: JsonObject;
  readonly metadata?: JsonObject | undefined;
}

export interface NexusInboxResponse {
  readonly messages: readonly NexusEnvelope[];
}

export interface SeenMessage extends AgentMessage {
  readonly deliveredAt: string;
}
