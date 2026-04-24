import type {
  AgentId,
  AgentMessage,
  AgentMessageInput,
  JsonObject,
  KoiError,
  MailboxComponent,
  MessageFilter,
  Result,
} from "@koi/core";
import { messageId } from "@koi/core";
import type { LocalMailboxConfig } from "./types.js";

const DEFAULT_MAX_MESSAGES = 10_000;

function deepFreeze(obj: JsonObject): JsonObject {
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value as JsonObject);
    }
  }
  return obj;
}

function safeCloneFreeze(
  field: "payload" | "metadata",
  value: JsonObject,
): Result<JsonObject, KoiError> {
  try {
    return { ok: true, value: deepFreeze(structuredClone(value)) };
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Message ${field} is not serializable: ${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
        context: { field },
      },
    };
  }
}

export function createLocalMailbox(config: LocalMailboxConfig): MailboxComponent & {
  readonly agentId: AgentId;
  readonly close: () => void;
} {
  const rawMax = config.maxMessages ?? DEFAULT_MAX_MESSAGES;
  if (!Number.isInteger(rawMax) || rawMax < 1) {
    throw new Error(`createLocalMailbox: maxMessages must be a positive integer, got ${rawMax}`);
  }
  const maxMessages = rawMax;
  const messages: AgentMessage[] = [];
  const subscribers = new Set<(message: AgentMessage) => void | Promise<void>>();
  // let rather than const: closed flag is explicitly mutable state
  let closed = false;
  // Self-reference for identity check in close()
  let self:
    | (MailboxComponent & { readonly agentId: AgentId; readonly close: () => void })
    | undefined;

  function evictIfNeeded(): void {
    while (messages.length > maxMessages) {
      messages.shift();
    }
  }

  self = {
    get agentId(): AgentId {
      return config.agentId;
    },

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

      // Deep-clone then deep-freeze payload/metadata — surface clone errors as Result.
      const payloadResult = safeCloneFreeze("payload", input.payload);
      if (!payloadResult.ok) return payloadResult;

      let metadata: JsonObject | undefined;
      if (input.metadata !== undefined) {
        const metaResult = safeCloneFreeze("metadata", input.metadata);
        if (!metaResult.ok) return metaResult;
        metadata = metaResult.value;
      }

      const msg: AgentMessage = Object.freeze({
        id: messageId(crypto.randomUUID()),
        createdAt: new Date().toISOString(),
        from: input.from,
        to: input.to,
        kind: input.kind,
        type: input.type,
        payload: payloadResult.value,
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      });

      messages.push(msg);
      evictIfNeeded();

      for (const handler of subscribers) {
        // Capture `closed` by reference — suppress delivery if close() runs
        // before this microtask fires. Catch handler errors to prevent
        // unhandled rejections from escaping the mailbox boundary.
        queueMicrotask(() => {
          if (closed) return;
          try {
            const result = handler(msg);
            if (result instanceof Promise) {
              result.catch(() => {});
            }
          } catch {
            // Handler threw synchronously — swallow to preserve isolation
          }
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
      // Only unregister if the router still points to this instance — prevents
      // a stale close() from evicting a live replacement registered after us.
      if (config.router !== undefined && config.router.get(config.agentId) === self) {
        config.router.unregister(config.agentId);
      }
    },
  };

  return self;
}
