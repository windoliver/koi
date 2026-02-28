/**
 * MailboxComponent implementation backed by Nexus IPC REST API.
 *
 * - send: maps to Nexus, returns Result<AgentMessage, KoiError>
 * - onMessage: registers handler, starts/stops polling automatically
 * - list: fetches inbox with optional filter
 *
 * Polling uses exponential backoff (1s→30s), resets on message received.
 */

import type {
  AgentId,
  AgentMessage,
  AgentMessageInput,
  KoiError,
  MailboxComponent,
  MessageFilter,
  Result,
} from "@koi/core";
import {
  DEFAULT_INBOX_PAGE_LIMIT,
  DEFAULT_NEXUS_BASE_URL,
  DEFAULT_POLL_MAX_MS,
  DEFAULT_POLL_MIN_MS,
  DEFAULT_POLL_MULTIPLIER,
  DEFAULT_TIMEOUT_MS,
} from "./constants.js";
import { mapKoiToNexus, mapNexusToKoi } from "./map-message.js";
import type { NexusClient } from "./nexus-client.js";
import { createNexusClient } from "./nexus-client.js";
import type { MessageHandler } from "./process-inbox.js";
import { processPendingMessages } from "./process-inbox.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusMailboxConfig {
  readonly agentId: AgentId;
  readonly baseUrl?: string | undefined;
  readonly authToken?: string | undefined;
  readonly pollMinMs?: number | undefined;
  readonly pollMaxMs?: number | undefined;
  readonly pollMultiplier?: number | undefined;
  readonly pageLimit?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a MailboxComponent backed by Nexus IPC. Implements Disposable for cleanup. */
export function createNexusMailbox(config: NexusMailboxConfig): MailboxComponent & Disposable {
  const {
    agentId,
    baseUrl = DEFAULT_NEXUS_BASE_URL,
    authToken,
    pollMinMs = DEFAULT_POLL_MIN_MS,
    pollMaxMs = DEFAULT_POLL_MAX_MS,
    pollMultiplier = DEFAULT_POLL_MULTIPLIER,
    pageLimit = DEFAULT_INBOX_PAGE_LIMIT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = config;

  const client: NexusClient = createNexusClient({ baseUrl, timeoutMs, authToken });
  const handlers = new Set<MessageHandler>();
  const seen = new Set<string>();

  // let justified: mutable polling state
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let currentInterval = pollMinMs;
  let disposed = false;

  // ----- Polling lifecycle -----

  function stopPolling(): void {
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  }

  function schedulePoll(): void {
    if (disposed || handlers.size === 0) return;

    pollTimer = setTimeout(async () => {
      const count = await processPendingMessages(
        client,
        agentId as string,
        handlers,
        seen,
        pageLimit,
      );

      // Reset backoff on message received, otherwise increase
      if (count > 0) {
        currentInterval = pollMinMs;
      } else {
        currentInterval = Math.min(currentInterval * pollMultiplier, pollMaxMs);
      }

      schedulePoll();
    }, currentInterval);
  }

  function maybeStartPolling(): void {
    if (pollTimer === undefined && handlers.size > 0 && !disposed) {
      currentInterval = pollMinMs;
      schedulePoll();
    }
  }

  function maybeStopPolling(): void {
    if (handlers.size === 0) {
      stopPolling();
    }
  }

  // ----- MailboxComponent implementation -----

  const send = async (message: AgentMessageInput): Promise<Result<AgentMessage, KoiError>> => {
    const nexusReq = mapKoiToNexus(message);
    const result = await client.sendMessage(nexusReq);
    if (!result.ok) return result;

    const mapped = mapNexusToKoi(result.value);
    if (mapped === undefined) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Nexus returned message with unknown kind",
          retryable: false,
          context: { kind: result.value.kind },
        },
      };
    }

    return { ok: true, value: mapped };
  };

  const onMessage = (handler: MessageHandler): (() => void) => {
    handlers.add(handler);
    maybeStartPolling();

    return () => {
      handlers.delete(handler);
      maybeStopPolling();
    };
  };

  const list = async (filter?: MessageFilter): Promise<readonly AgentMessage[]> => {
    const limit = filter?.limit ?? pageLimit;
    const result = await client.listInbox(agentId as string, limit);
    if (!result.ok) return [];

    const messages: AgentMessage[] = [];
    for (const envelope of result.value) {
      const mapped = mapNexusToKoi(envelope);
      if (mapped === undefined) continue;

      // Apply client-side filters
      if (filter?.kind !== undefined && mapped.kind !== filter.kind) continue;
      if (filter?.type !== undefined && mapped.type !== filter.type) continue;
      if (filter?.from !== undefined && mapped.from !== filter.from) continue;

      messages.push(mapped);
    }

    return messages;
  };

  const dispose = (): void => {
    disposed = true;
    stopPolling();
    handlers.clear();
    seen.clear();
  };

  return {
    send,
    onMessage,
    list,
    [Symbol.dispose]: dispose,
  };
}
