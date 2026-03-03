/**
 * Inbound message debouncer.
 *
 * Batches rapid consecutive messages from the same sender/conversation
 * into a single InboundMessage. Prevents duplicate LLM calls when
 * users send multiple lines in quick succession.
 */

import type { ContentBlock, InboundMessage } from "@koi/core";

/** Configuration for the inbound debouncer. */
export interface DebouncerConfig {
  /** Debounce window in milliseconds. Default: 500. */
  readonly windowMs?: number;
  /** Key extractor: determines which messages to merge. Default: senderId + threadId. */
  readonly keyFn?: (msg: InboundMessage) => string;
}

/** Debouncer instance returned by createDebouncer(). */
export interface Debouncer {
  /** Submit a message. Returns a Promise that resolves with the merged message after the window. */
  readonly submit: (msg: InboundMessage) => Promise<InboundMessage>;
  /** Cancel all pending timers and flush remaining messages immediately. */
  readonly dispose: () => void;
}

/** Default debounce window. */
const DEFAULT_WINDOW_MS = 500;

/** Default key: merge by senderId + threadId. */
function defaultKey(msg: InboundMessage): string {
  return `${msg.senderId ?? "unknown"}:${msg.threadId ?? "unknown"}`;
}

interface PendingEntry {
  readonly messages: readonly InboundMessage[];
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (merged: InboundMessage) => void;
  readonly resolvers: readonly ((merged: InboundMessage) => void)[];
}

/**
 * Creates an inbound message debouncer.
 *
 * Messages with the same key arriving within `windowMs` are merged into
 * a single InboundMessage with concatenated content blocks.
 */
export function createDebouncer(config?: DebouncerConfig): Debouncer {
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
  const keyFn = config?.keyFn ?? defaultKey;

  // let justified: mutable pending map for timer management
  let pending = new Map<string, PendingEntry>();

  const flush = (key: string): void => {
    const entry = pending.get(key);
    if (entry === undefined) return;

    pending = new Map([...pending].filter(([k]) => k !== key));

    const merged = mergeMessages(entry.messages);
    for (const r of entry.resolvers) {
      r(merged);
    }
  };

  const submit = (msg: InboundMessage): Promise<InboundMessage> => {
    return new Promise<InboundMessage>((resolve) => {
      const key = keyFn(msg);
      const existing = pending.get(key);

      if (existing !== undefined) {
        clearTimeout(existing.timer);
        const timer = setTimeout(() => flush(key), windowMs);
        const updated: PendingEntry = {
          messages: [...existing.messages, msg],
          timer,
          resolve: existing.resolve,
          resolvers: [...existing.resolvers, resolve],
        };
        pending = new Map([...pending].map(([k, v]) => (k === key ? [k, updated] : [k, v])));
      } else {
        const timer = setTimeout(() => flush(key), windowMs);
        const entry: PendingEntry = {
          messages: [msg],
          timer,
          resolve,
          resolvers: [resolve],
        };
        pending = new Map([...pending, [key, entry]]);
      }
    });
  };

  const dispose = (): void => {
    for (const [_key, entry] of pending) {
      clearTimeout(entry.timer);
      const merged = mergeMessages(entry.messages);
      for (const r of entry.resolvers) {
        r(merged);
      }
    }
    pending = new Map();
  };

  return { submit, dispose };
}

/** Merges multiple InboundMessages into one, concatenating content blocks. */
function mergeMessages(messages: readonly InboundMessage[]): InboundMessage {
  if (messages.length === 1 && messages[0] !== undefined) {
    return messages[0];
  }

  const allBlocks: ContentBlock[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      allBlocks.push(block);
    }
  }

  const first = messages[0];
  if (first === undefined) {
    throw new Error("[channel-base] Cannot merge zero messages");
  }

  const merged: InboundMessage = {
    content: allBlocks,
    senderId: first.senderId,
    timestamp: first.timestamp,
  };
  if (first.threadId !== undefined) {
    return { ...merged, threadId: first.threadId };
  }
  return merged;
}
