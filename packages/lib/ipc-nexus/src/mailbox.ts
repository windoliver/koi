import type { AgentMessage, MailboxComponent, MessageFilter } from "@koi/core";
import { createNexusMailboxClient } from "./client.js";
import { mapNexusEnvelopeToAgentMessage } from "./map-message.js";
import { createSeenSet } from "./seen-set.js";
import type { NexusMailboxConfig } from "./types.js";

const DEFAULT_PREFIX = "ipc";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export async function createNexusMailbox(config: NexusMailboxConfig): Promise<MailboxComponent> {
  const prefix = config.inboxMethodPrefix ?? DEFAULT_PREFIX;
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (config.transport.health !== undefined) {
    const health = await config.transport.health();
    if (!health.ok && config.fallback !== undefined) {
      return config.fallback;
    }
  }

  const client = createNexusMailboxClient(config.transport, prefix);
  const seen = createSeenSet();
  const handlers = new Set<(message: AgentMessage) => void | Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let degraded = false;

  async function dispatchMessages(messages: readonly AgentMessage[]): Promise<void> {
    for (const message of messages) {
      for (const handler of handlers) {
        await handler(message);
      }
    }
  }

  async function listFromNexus(limit: number): Promise<readonly AgentMessage[]> {
    const listed = await client.list(config.agentId as string, limit);
    if (!listed.ok) {
      if (config.fallback !== undefined) {
        degraded = true;
        return [];
      }
      return [];
    }
    return listed.value.map(mapNexusEnvelopeToAgentMessage);
  }

  async function pollOnce(): Promise<void> {
    if (degraded && config.fallback !== undefined) return;
    const messages = await listFromNexus(pageSize);
    const unseen = messages.filter((message) => {
      if (seen.has(message.id as string)) return false;
      seen.add(message);
      return true;
    });
    await dispatchMessages(unseen);
  }

  function ensurePolling(): void {
    if (timer !== null || degraded || handlers.size === 0) return;
    timer = setInterval(() => {
      void pollOnce();
    }, pollIntervalMs);
  }

  function stopPolling(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function list(filter?: MessageFilter): Promise<readonly AgentMessage[]> {
    if (degraded && config.fallback !== undefined) {
      return config.fallback.list(filter);
    }
    const messages = await listFromNexus(filter?.limit ?? pageSize);
    return messages.filter((message) => {
      if (filter?.kind !== undefined && message.kind !== filter.kind) return false;
      if (filter?.type !== undefined && message.type !== filter.type) return false;
      if (filter?.from !== undefined && message.from !== filter.from) return false;
      return true;
    });
  }

  return {
    send: async (message) => {
      if (degraded && config.fallback !== undefined) {
        return config.fallback.send(message);
      }
      const result = await client.send(message);
      if (!result.ok) {
        if (config.fallback !== undefined) {
          degraded = true;
          return config.fallback.send(message);
        }
        return result;
      }
      return { ok: true, value: mapNexusEnvelopeToAgentMessage(result.value) };
    },
    onMessage: (handler) => {
      if (degraded && config.fallback !== undefined) {
        return config.fallback.onMessage(handler);
      }
      handlers.add(handler);
      ensurePolling();
      void pollOnce();
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) stopPolling();
      };
    },
    list,
    drain: () => {
      if (degraded && config.fallback !== undefined) {
        return config.fallback.drain();
      }
      return seen.drain();
    },
  };
}
