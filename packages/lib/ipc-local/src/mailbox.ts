import type {
  AgentMessage,
  AgentMessageInput,
  KoiError,
  MailboxComponent,
  MessageFilter,
  Result,
} from "@koi/core";
import { messageId } from "@koi/core";
import type { LocalMailboxConfig } from "./types.js";

const DEFAULT_MAX_MESSAGES = 10_000;

export function createLocalMailbox(config: LocalMailboxConfig): MailboxComponent & {
  readonly close: () => void;
} {
  const maxMessages = config.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const messages: AgentMessage[] = [];
  const subscribers = new Set<(message: AgentMessage) => void | Promise<void>>();

  function evictIfNeeded(): void {
    while (messages.length > maxMessages) {
      messages.shift();
    }
  }

  return {
    async send(input: AgentMessageInput): Promise<Result<AgentMessage, KoiError>> {
      const msg: AgentMessage = {
        id: messageId(crypto.randomUUID()),
        createdAt: new Date().toISOString(),
        from: input.from,
        to: input.to,
        kind: input.kind,
        type: input.type,
        payload: input.payload,
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };

      messages.push(msg);
      evictIfNeeded();

      for (const handler of subscribers) {
        queueMicrotask(() => {
          void handler(msg);
        });
      }

      return { ok: true, value: msg };
    },

    onMessage(handler: (message: AgentMessage) => void | Promise<void>): () => void {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    list(filter?: MessageFilter): readonly AgentMessage[] {
      const result: AgentMessage[] = [];
      for (const msg of messages) {
        if (filter?.kind !== undefined && msg.kind !== filter.kind) continue;
        if (filter?.type !== undefined && msg.type !== filter.type) continue;
        if (filter?.from !== undefined && msg.from !== filter.from) continue;
        result.push(msg);
        if (filter?.limit !== undefined && result.length >= filter.limit) break;
      }
      return result;
    },

    close(): void {
      messages.length = 0;
      subscribers.clear();
    },
  };
}
