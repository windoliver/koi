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
  const rawMax = config.maxMessages ?? DEFAULT_MAX_MESSAGES;
  if (!Number.isInteger(rawMax) || rawMax < 1) {
    throw new Error(`createLocalMailbox: maxMessages must be a positive integer, got ${rawMax}`);
  }
  const maxMessages = rawMax;
  const messages: AgentMessage[] = [];
  const subscribers = new Set<(message: AgentMessage) => void | Promise<void>>();
  // let rather than const: the closed flag is explicitly mutable state
  let closed = false;

  function evictIfNeeded(): void {
    while (messages.length > maxMessages) {
      messages.shift();
    }
  }

  return {
    async send(input: AgentMessageInput): Promise<Result<AgentMessage, KoiError>> {
      if (closed) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: "Mailbox is closed",
            retryable: false,
            context: { agentId: config.agentId },
          },
        };
      }

      // Cross-agent delivery: route via injected router, or reject if none.
      if (input.to !== config.agentId) {
        if (config.router !== undefined) {
          const target = config.router.get(input.to);
          if (target === undefined) {
            return {
              ok: false,
              error: {
                code: "NOT_FOUND",
                message: `No mailbox registered for agent ${input.to}`,
                retryable: false,
                context: { agentId: input.to },
              },
            };
          }
          return target.send(input);
        }
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `No router configured; cannot deliver to ${input.to}`,
            retryable: false,
            context: { agentId: input.to },
          },
        };
      }

      // Deep-clone payload/metadata so later mutations to the caller's objects
      // cannot corrupt the stored message history.
      const msg: AgentMessage = Object.freeze({
        id: messageId(crypto.randomUUID()),
        createdAt: new Date().toISOString(),
        from: input.from,
        to: input.to,
        kind: input.kind,
        type: input.type,
        payload: structuredClone(input.payload),
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
        ...(input.metadata !== undefined ? { metadata: structuredClone(input.metadata) } : {}),
      });

      messages.push(msg);
      evictIfNeeded();

      for (const handler of subscribers) {
        // Capture `closed` by reference — suppress delivery if close() runs
        // before this microtask fires.
        queueMicrotask(() => {
          if (!closed) void handler(msg);
        });
      }

      return { ok: true, value: msg };
    },

    onMessage(handler: (message: AgentMessage) => void | Promise<void>): () => void {
      if (closed) return () => {};
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    list(filter?: MessageFilter): readonly AgentMessage[] {
      if (closed) return [];
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
      closed = true;
      messages.length = 0;
      subscribers.clear();
    },
  };
}
