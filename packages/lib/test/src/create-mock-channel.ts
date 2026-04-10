/**
 * Mock ChannelAdapter that captures outbound messages instead of sending
 * them to real I/O, and allows tests to simulate inbound messages.
 */

import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
} from "@koi/core";

export interface MockChannelConfig {
  readonly name?: string;
  readonly capabilities?: Partial<ChannelCapabilities>;
  /**
   * Default: `false` — matches the production channel adapter, which
   * dispatches via `Promise.allSettled` and only reports handler failures
   * via an out-of-band callback. `receive()` resolves after full fan-out
   * even when a handler throws; failures are recorded in `handlerErrors`.
   *
   * Set to `true` to make `receive()` reject with an `AggregateError`
   * after dispatch when any handler failed — useful for tests that want
   * failures to surface at the call site without asserting on
   * `handlerErrors` manually.
   */
  readonly failFastOnHandlerError?: boolean;
}

export interface HandlerFailure {
  readonly error: unknown;
  readonly message: InboundMessage;
}

export interface MockChannelResult {
  readonly adapter: ChannelAdapter;
  readonly sent: readonly OutboundMessage[];
  readonly statuses: readonly ChannelStatus[];
  /** Simulate an inbound message. Throws if no handler is registered. */
  readonly receive: (message: InboundMessage) => Promise<void>;
  /**
   * Every handler rejection seen during `receive()`. Fan-out is isolated
   * (one throwing handler does not starve siblings), but failures are
   * still observable so tests do not silently pass on a broken path.
   */
  readonly handlerErrors: readonly HandlerFailure[];
  readonly connected: () => boolean;
}

const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
};

interface HandlerEntry {
  readonly fn: MessageHandler;
  readonly id: number;
}

export function createMockChannel(config?: MockChannelConfig): MockChannelResult {
  const sent: OutboundMessage[] = [];
  const statuses: ChannelStatus[] = [];
  const handlerErrors: HandlerFailure[] = [];
  // Mirror the production channel-base adapter: per-registration entries
  // with a monotonic id, so the same function can be registered multiple
  // times and each unsubscribe removes exactly its own entry.
  // let required: monotonic counter for unique subscription IDs.
  let nextId = 0;
  let handlers: readonly HandlerEntry[] = [];
  let isConnected = false;

  const adapter: ChannelAdapter = {
    name: config?.name ?? "mock-channel",
    capabilities: { ...DEFAULT_CAPABILITIES, ...config?.capabilities },

    async connect(): Promise<void> {
      isConnected = true;
    },

    async disconnect(): Promise<void> {
      isConnected = false;
    },

    async send(message: OutboundMessage): Promise<void> {
      sent.push(message);
    },

    onMessage(h: MessageHandler): () => void {
      const id = nextId++;
      handlers = [...handlers, { fn: h, id }];
      // let required: tracks whether this specific subscription is still active.
      let active = true;
      return (): void => {
        if (!active) return;
        active = false;
        handlers = handlers.filter((entry) => entry.id !== id);
      };
    },

    async sendStatus(status: ChannelStatus): Promise<void> {
      statuses.push(status);
    },
  };

  return {
    adapter,
    sent,
    statuses,
    handlerErrors,
    receive: async (message: InboundMessage): Promise<void> => {
      if (handlers.length === 0) {
        throw new Error(
          "createMockChannel: receive() called before onMessage() registered a handler",
        );
      }
      // Snapshot and fan out concurrently via Promise.allSettled, exactly
      // like the production channel-base dispatch. A handler that throws
      // *synchronously* (i.e. a non-async function that throws before
      // returning a promise) will abort `Array.map` before `allSettled`
      // runs — matching production. We intentionally do NOT normalize
      // sync throws into rejections, so tests faithfully reproduce
      // production behavior when consumers pass a non-async handler.
      const snapshot = handlers;
      const results = await Promise.allSettled(snapshot.map((entry) => entry.fn(message)));
      const rejections: unknown[] = [];
      for (const result of results) {
        if (result.status === "rejected") {
          handlerErrors.push({ error: result.reason, message });
          rejections.push(result.reason);
        }
      }
      // Default matches the production adapter: `receive()` resolves
      // after full dispatch even when handlers fail; failures are only
      // observable via `handlerErrors`. Opt into fail-fast surfacing
      // with `failFastOnHandlerError: true`.
      if (rejections.length > 0 && config?.failFastOnHandlerError === true) {
        throw new AggregateError(
          rejections,
          `createMockChannel: ${rejections.length} handler(s) rejected during receive()`,
        );
      }
    },
    connected: (): boolean => isConnected,
  };
}
