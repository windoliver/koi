import type { ContentBlock, JsonObject } from "@koi/core";

export interface InboxEnvelope {
  readonly content: readonly ContentBlock[];
  readonly threadId?: string;
  readonly metadata?: JsonObject;
  readonly enqueuedAt: number;
}

export interface InboxSink {
  readonly enqueue: (envelope: InboxEnvelope) => void | Promise<void>;
}
