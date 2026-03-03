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

/** Metadata emitted when a message is dropped due to inbox overflow. */
export interface InboxDropEvent {
  readonly agentId: string;
  readonly dropped: QueuedAgentMessage;
}

/** Options for createAgentInbox(). */
export interface AgentInboxOptions {
  /** Called when a message is dropped due to inbox overflow. */
  readonly onDrop?: ((event: InboxDropEvent) => void) | undefined;
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
  if (!Array.isArray(record.content)) return false;
  // Empty array is valid (metadata-only message)
  if (record.content.length === 0) return true;
  // Spot-check first element: must be an object with a `kind` field
  const first: unknown = record.content[0];
  return typeof first === "object" && first !== null && "kind" in first;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentInbox(options?: AgentInboxOptions): AgentInbox {
  const queues = new Map<string, QueuedAgentMessage[]>();
  const onDrop = options?.onDrop;

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
        const dropped = queue.shift();
        if (dropped !== undefined && onDrop !== undefined) {
          onDrop({ agentId, dropped });
        }
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
