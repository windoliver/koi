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

/**
 * Fetch one page of inbox messages, dispatch unseen ones to all handlers.
 *
 * @returns Number of newly processed messages.
 */
export async function processPendingMessages(
  client: NexusClient,
  agentId: string,
  handlers: ReadonlySet<MessageHandler>,
  seen: Set<string>,
  limit: number,
): Promise<number> {
  const result = await client.listInbox(agentId, limit);
  if (!result.ok) return 0;

  // let justified: count mutated in loop
  let processed = 0;

  for (const envelope of result.value) {
    if (seen.has(envelope.id)) continue;
    seen.add(envelope.id);

    const message = mapNexusToKoi(envelope);
    if (message === undefined) continue;

    for (const handler of handlers) {
      try {
        await handler(message);
      } catch (_err: unknown) {
        // Handler errors must not crash the polling loop.
        // Logging would be added by middleware/telemetry at a higher layer.
      }
    }

    processed += 1;
  }

  return processed;
}
