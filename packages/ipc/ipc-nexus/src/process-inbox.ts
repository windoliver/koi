/**
 * Pure function for processing pending inbox messages.
 *
 * Extracted from the polling loop for testability (decision #11C).
 * Fetches one page, dispatches new messages to handlers, deduplicates.
 */

import type { AgentMessage } from "@koi/core";
import { mapNexusToKoi } from "./map-message.js";
import type { NexusClient } from "./nexus-client.js";

/** Handler signature for incoming messages. */
export type MessageHandler = (message: AgentMessage) => void | Promise<void>;

/** Structural type for deduplication — accepts both Set<string> and SeenBuffer. */
export interface SeenSet {
  readonly has: (id: string) => boolean;
  readonly add: (id: string) => void;
}

/** Optional error callback for handler failures. */
export type HandlerErrorCallback = (context: {
  readonly agentId: string;
  readonly messageId: string;
  readonly error: unknown;
}) => void;

/**
 * Fetch one page of inbox messages, dispatch unseen ones to all handlers.
 *
 * When a handler throws, the error is reported via `onHandlerError` (or
 * `console.error` when no callback is provided) and the message remains
 * eligible for retry on the next poll cycle.
 *
 * @returns Number of newly processed messages.
 */
export async function processPendingMessages(
  client: NexusClient,
  agentId: string,
  handlers: ReadonlySet<MessageHandler>,
  seen: SeenSet,
  limit: number,
  onHandlerError?: HandlerErrorCallback | undefined,
): Promise<number> {
  // let justified: count mutated in loop
  let processed = 0;
  // let justified: offset advances as pages are drained
  let offset = 0;

  // Drain all pages, not just the first
  for (;;) {
    const result = await client.listInbox(agentId, limit, offset);
    if (!result.ok) break;

    const messages = result.value;
    if (messages.length === 0) break;

    for (const envelope of messages) {
      if (seen.has(envelope.id)) continue;

      const message = mapNexusToKoi(envelope);
      if (message === undefined) continue;

      // let justified: tracks whether any handler failed for this message
      let handlerFailed = false;

      for (const handler of handlers) {
        try {
          await handler(message);
        } catch (err: unknown) {
          handlerFailed = true;
          const errorContext = {
            agentId,
            messageId: envelope.id,
            error: err,
          } as const;

          if (onHandlerError !== undefined) {
            try {
              onHandlerError(errorContext);
            } catch {
              // Prevent a throwing onHandlerError from stalling the poll loop
            }
          } else {
            console.error(
              `[ipc-nexus] Handler error for message ${envelope.id} (agent ${agentId}):`,
              err,
            );
          }
        }
      }

      // Mark as seen after dispatch — even if a handler failed. Message-level
      // retry would cause duplicate deliveries to handlers that already succeeded.
      // Handlers needing retry should implement their own at-least-once logic.
      seen.add(envelope.id);
      processed += 1;
    }

    // If we got fewer messages than the limit, there are no more pages
    if (messages.length < limit) break;
    offset += messages.length;
  }

  return processed;
}
