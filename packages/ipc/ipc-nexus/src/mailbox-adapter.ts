/**
 * MailboxComponent implementation backed by Nexus IPC REST API.
 *
 * - send: maps to Nexus, returns Result<AgentMessage, KoiError>
 * - onMessage: registers handler, starts delivery automatically
 * - list: fetches inbox with optional filter
 *
 * Supports two delivery modes:
 * - "sse" (default): SSE push notifications trigger inbox fetch. Falls back to polling on failure.
 * - "polling": exponential backoff (1s→30s), resets on message received.
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
import type { DeliveryMode } from "./constants.js";
import {
  DEFAULT_DELIVERY_MODE,
  DEFAULT_INBOX_PAGE_LIMIT,
  DEFAULT_NEXUS_BASE_URL,
  DEFAULT_POLL_MAX_MS,
  DEFAULT_POLL_MIN_MS,
  DEFAULT_POLL_MULTIPLIER,
  DEFAULT_SEEN_CAPACITY,
  DEFAULT_SSE_FALLBACK_CHECK_MS,
  DEFAULT_TIMEOUT_MS,
} from "./constants.js";
import { mapKoiToNexus, mapNexusToKoi, mapSendResponseToKoi } from "./map-message.js";
import type { NexusClient } from "./nexus-client.js";
import { createNexusClient } from "./nexus-client.js";
import type { HandlerErrorCallback, MessageHandler } from "./process-inbox.js";
import { processPendingMessages } from "./process-inbox.js";
import { createSeenBuffer } from "./seen-buffer.js";
import type { SseTransport } from "./sse-transport.js";
import { createSseTransport } from "./sse-transport.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusMailboxConfig {
  readonly agentId: AgentId;
  readonly baseUrl?: string | undefined;
  readonly authToken?: string | undefined;
  readonly delivery?: DeliveryMode | undefined;
  readonly seenCapacity?: number | undefined;
  readonly pollMinMs?: number | undefined;
  readonly pollMaxMs?: number | undefined;
  readonly pollMultiplier?: number | undefined;
  readonly pageLimit?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /** Called when SSE delivery falls back to polling. */
  readonly onDeliveryFallback?: ((from: DeliveryMode, to: DeliveryMode) => void) | undefined;
  /** Called when a message handler throws. Receives agent ID, message ID, and the error. */
  readonly onHandlerError?: HandlerErrorCallback | undefined;
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
    delivery = DEFAULT_DELIVERY_MODE,
    seenCapacity = DEFAULT_SEEN_CAPACITY,
    pollMinMs = DEFAULT_POLL_MIN_MS,
    pollMaxMs = DEFAULT_POLL_MAX_MS,
    pollMultiplier = DEFAULT_POLL_MULTIPLIER,
    pageLimit = DEFAULT_INBOX_PAGE_LIMIT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onDeliveryFallback,
    onHandlerError,
  } = config;

  const client: NexusClient = createNexusClient({ baseUrl, timeoutMs, authToken });
  const handlers = new Set<MessageHandler>();
  const seen = createSeenBuffer(seenCapacity);

  // Note: inbox provisioning is automatic during Nexus agent registration
  // (AgentRegistrationService.register → Step 5). No explicit provision call
  // needed — the inbox exists as long as the agent is registered in Nexus.

  // let justified: mutable delivery state
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let currentInterval = pollMinMs;
  let disposed = false;
  let sseTransport: SseTransport | undefined;
  let sseUnsub: (() => void) | undefined;
  // let justified: tracks whether we fell back from SSE to polling
  let activeDelivery: DeliveryMode = delivery;

  // ----- Shared: fetch + dispatch inbox -----

  async function fetchAndDispatch(): Promise<void> {
    if (disposed || handlers.size === 0) return;
    await processPendingMessages(
      client,
      agentId as string,
      handlers,
      seen,
      pageLimit,
      onHandlerError,
    );
  }

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
        onHandlerError,
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

  function startPolling(): void {
    if (pollTimer === undefined && handlers.size > 0 && !disposed) {
      currentInterval = pollMinMs;
      schedulePoll();
    }
  }

  // ----- SSE lifecycle -----

  function startSse(): void {
    if (disposed || sseTransport !== undefined) return;

    const sseUrl = `${baseUrl}/api/v2/events/stream`;
    sseTransport = createSseTransport({
      url: sseUrl,
      agentId: agentId as string,
      authToken,
    });

    sseUnsub = sseTransport.onNotification(() => {
      void fetchAndDispatch();
    });

    sseTransport.start();

    // Drain pre-existing inbox messages before relying on SSE notifications
    void fetchAndDispatch();

    // Check connection after a brief delay — if not connected, fall back to polling
    setTimeout(() => {
      if (disposed) return;
      if (sseTransport !== undefined && !sseTransport.connected()) {
        // SSE failed to establish — fall back to polling
        onDeliveryFallback?.("sse", "polling");
        stopSse();
        activeDelivery = "polling";
        startPolling();
      }
    }, DEFAULT_SSE_FALLBACK_CHECK_MS);
  }

  function stopSse(): void {
    if (sseUnsub !== undefined) {
      sseUnsub();
      sseUnsub = undefined;
    }
    if (sseTransport !== undefined) {
      sseTransport.stop();
      sseTransport = undefined;
    }
  }

  // ----- Delivery start/stop -----

  function startDelivery(): void {
    if (disposed || handlers.size === 0) return;
    if (activeDelivery === "sse") {
      startSse();
    } else {
      startPolling();
    }
  }

  function stopDelivery(): void {
    stopPolling();
    stopSse();
  }

  // ----- MailboxComponent implementation -----

  const send = async (message: AgentMessageInput): Promise<Result<AgentMessage, KoiError>> => {
    const nexusReq = mapKoiToNexus(message);
    const result = await client.sendMessage(nexusReq);
    if (!result.ok) return result;

    // Send response is a subset (message_id, path, sender, recipient, type)
    // — not a full envelope. Use the dedicated mapper that reconstructs the
    // full AgentMessage from the response + original input.
    return { ok: true, value: mapSendResponseToKoi(result.value, message) };
  };

  const onMessage = (handler: MessageHandler): (() => void) => {
    handlers.add(handler);
    startDelivery();

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        stopDelivery();
      }
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
    stopDelivery();
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
