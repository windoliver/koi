/**
 * Queue-per-agent inbox for buffering inbound `agent:message` frames.
 *
 * Each agent gets an independent FIFO queue. When a queue exceeds
 * MAX_INBOX_DEPTH the oldest message is dropped to bound memory.
 */

import type { JsonObject } from "@koi/core/common";
import type { ContentBlock } from "@koi/core/message";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_INBOX_DEPTH = 100 as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Payload delivered via an `agent:message` frame. */
export interface AgentMessagePayload {
  readonly content: readonly ContentBlock[];
  readonly senderId?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}

/** A queued message with reception timestamp. */
export interface QueuedAgentMessage {
  readonly payload: AgentMessagePayload;
  readonly receivedAt: number;
}

/** Per-agent message inbox with FIFO semantics. */
export interface AgentInbox {
  /** Append a message to the agent's queue. Drops oldest if over capacity. */
  readonly push: (agentId: string, payload: AgentMessagePayload) => void;
  /** Return all queued messages and clear the queue. */
  readonly drain: (agentId: string) => readonly QueuedAgentMessage[];
  /** Number of messages currently queued for the agent. */
  readonly depth: (agentId: string) => number;
  /** Remove all queued messages for the agent. */
  readonly clear: (agentId: string) => void;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/** Validates that a value conforms to AgentMessagePayload at runtime. */
export function isAgentMessagePayload(value: unknown): value is AgentMessagePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.content);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentInbox(): AgentInbox {
  const queues = new Map<string, QueuedAgentMessage[]>();

  return {
    push(agentId, payload) {
      // let: queue may not exist yet, need mutable reference for append
      let queue = queues.get(agentId);
      if (queue === undefined) {
        queue = [];
        queues.set(agentId, queue);
      }

      const message: QueuedAgentMessage = {
        payload,
        receivedAt: Date.now(),
      };

      queue.push(message);

      if (queue.length > MAX_INBOX_DEPTH) {
        queue.shift();
      }
    },

    drain(agentId) {
      const queue = queues.get(agentId);
      if (queue === undefined) {
        return [];
      }
      const snapshot: readonly QueuedAgentMessage[] = [...queue];
      queues.delete(agentId);
      return snapshot;
    },

    depth(agentId) {
      return queues.get(agentId)?.length ?? 0;
    },

    clear(agentId) {
      queues.delete(agentId);
    },
  };
}
