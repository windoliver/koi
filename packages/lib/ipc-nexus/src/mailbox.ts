import type {
  AgentMessage,
  AgentMessageInput,
  KoiError,
  MailboxComponent,
  MessageFilter,
  Result,
} from "@koi/core";
import type { NexusMailboxClient } from "./client.js";
import { createNexusMailboxClient } from "./client.js";
import { mapNexusEnvelopeToAgentMessage } from "./map-message.js";
import { createSeenSet, type SeenSet } from "./seen-set.js";
import type { NexusMailboxConfig } from "./types.js";

const DEFAULT_PREFIX = "ipc";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

type Handler = (message: AgentMessage) => void | Promise<void>;

interface State {
  readonly client: NexusMailboxClient;
  readonly seen: SeenSet;
  readonly handlers: Set<Handler>;
  readonly timer: { value: ReturnType<typeof setInterval> | null };
  readonly degraded: { value: boolean };
  readonly agentId: string;
  readonly pageSize: number;
  readonly pollIntervalMs: number;
  readonly fallback: MailboxComponent | undefined;
}

export async function createNexusMailbox(config: NexusMailboxConfig): Promise<MailboxComponent> {
  const prefix = config.inboxMethodPrefix ?? DEFAULT_PREFIX;
  if (config.transport.health !== undefined) {
    const health = await config.transport.health();
    if (!health.ok && config.fallback !== undefined) return config.fallback;
  }
  const state: State = {
    client: createNexusMailboxClient(config.transport, prefix),
    seen: createSeenSet(),
    handlers: new Set(),
    timer: { value: null },
    degraded: { value: false },
    agentId: config.agentId as string,
    pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    fallback: config.fallback,
  };
  return {
    send: (m) => sendMessage(state, m),
    onMessage: (h) => subscribeHandler(state, h),
    list: (f) => listMessages(state, f),
    drain: () => drainMessages(state),
  };
}

async function dispatchMessages(s: State, messages: readonly AgentMessage[]): Promise<void> {
  // Handler errors are isolated so the polling loop survives a thrown handler.
  for (const message of messages) {
    for (const handler of s.handlers) {
      await Promise.resolve()
        .then(() => handler(message))
        .catch(() => {});
    }
  }
}

async function listFromNexus(s: State, limit: number): Promise<readonly AgentMessage[]> {
  const listed = await s.client.list(s.agentId, limit);
  if (!listed.ok) {
    if (s.fallback !== undefined) s.degraded.value = true;
    return [];
  }
  return listed.value.map(mapNexusEnvelopeToAgentMessage);
}

async function pollOnce(s: State): Promise<void> {
  if (s.degraded.value && s.fallback !== undefined) return;
  const messages = await listFromNexus(s, s.pageSize);
  const unseen = messages.filter((message) => {
    if (s.seen.has(message.id as string)) return false;
    s.seen.add(message);
    return true;
  });
  await dispatchMessages(s, unseen);
}

function ensurePolling(s: State): void {
  if (s.timer.value !== null || s.degraded.value || s.handlers.size === 0) return;
  s.timer.value = setInterval(() => {
    void pollOnce(s);
  }, s.pollIntervalMs);
}

function stopPolling(s: State): void {
  if (s.timer.value !== null) {
    clearInterval(s.timer.value);
    s.timer.value = null;
  }
}

async function sendMessage(
  s: State,
  message: AgentMessageInput,
): Promise<Result<AgentMessage, KoiError>> {
  if (s.degraded.value && s.fallback !== undefined) return s.fallback.send(message);
  const result = await s.client.send(message);
  if (!result.ok) {
    if (s.fallback !== undefined) {
      s.degraded.value = true;
      return s.fallback.send(message);
    }
    return result;
  }
  return { ok: true, value: mapNexusEnvelopeToAgentMessage(result.value) };
}

function subscribeHandler(s: State, handler: Handler): () => void {
  if (s.degraded.value && s.fallback !== undefined) return s.fallback.onMessage(handler);
  s.handlers.add(handler);
  ensurePolling(s);
  void pollOnce(s);
  return () => {
    s.handlers.delete(handler);
    if (s.handlers.size === 0) stopPolling(s);
  };
}

async function listMessages(s: State, filter?: MessageFilter): Promise<readonly AgentMessage[]> {
  if (s.degraded.value && s.fallback !== undefined) return s.fallback.list(filter);
  const messages = await listFromNexus(s, filter?.limit ?? s.pageSize);
  return messages.filter((message) => {
    if (filter?.kind !== undefined && message.kind !== filter.kind) return false;
    if (filter?.type !== undefined && message.type !== filter.type) return false;
    if (filter?.from !== undefined && message.from !== filter.from) return false;
    return true;
  });
}

function drainMessages(s: State): readonly AgentMessage[] | Promise<readonly AgentMessage[]> {
  if (s.degraded.value && s.fallback !== undefined) return s.fallback.drain();
  return s.seen.drain();
}
