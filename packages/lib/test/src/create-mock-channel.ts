/**
 * Mock ChannelAdapter that captures outbound messages instead of sending
 * them to real I/O, and allows tests to simulate inbound messages.
 *
 * Mirrors the production channel-base adapter for lifecycle gating and
 * capability-aware content rendering so tests reflect what the real
 * transport would accept.
 */

import { renderBlocks } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  ContentBlock,
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
  /**
   * Default: `false`. When `false`, the mock enforces production
   * lifecycle gating: `send()` rejects while disconnected, `sendStatus()`
   * is a no-op while disconnected, and `receive()` drops inbound
   * messages while disconnected. Set to `true` to bypass all lifecycle
   * gating — useful only for tests that deliberately exercise the
   * disconnected state with explicit assertions.
   */
  readonly bypassLifecycleChecks?: boolean;
}

export interface HandlerFailure {
  readonly error: unknown;
  readonly message: InboundMessage;
}

export interface MockChannelResult {
  readonly adapter: ChannelAdapter;
  /**
   * Outbound messages exactly as the caller passed them to `send()`,
   * with no capability-based rewrite. This is the default assertion
   * surface so tests see what the application actually emitted.
   */
  readonly sent: readonly OutboundMessage[];
  /**
   * Outbound messages after `renderBlocks(...)` has downgraded any
   * unsupported blocks against the configured capabilities — the same
   * bytes a real transport would see. Use this when the test cares
   * about wire-level fidelity rather than application intent.
   */
  readonly sentRendered: readonly OutboundMessage[];
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
  const sentRendered: OutboundMessage[] = [];
  const statuses: ChannelStatus[] = [];
  const handlerErrors: HandlerFailure[] = [];
  // Mirror the production channel-base adapter: per-registration entries
  // with a monotonic id, so the same function can be registered multiple
  // times and each unsubscribe removes exactly its own entry.
  // let required: monotonic counter for unique subscription IDs.
  let nextId = 0;
  let handlers: readonly HandlerEntry[] = [];
  let isConnected = false;
  // Distinguish "never connected" (setup mistake — should be loud) from
  // "explicitly disconnected" (teardown race — should match production's
  // silent drop). Flipped to true on the first connect() call and never
  // reset, so repeated connect/disconnect cycles keep the silent-drop
  // semantics for later receives.
  let everConnected = false;
  const bypassLifecycle = config?.bypassLifecycleChecks === true;
  const capabilities: ChannelCapabilities = {
    ...DEFAULT_CAPABILITIES,
    ...config?.capabilities,
  };
  const channelName = config?.name ?? "mock-channel";

  const adapter: ChannelAdapter = {
    name: channelName,
    capabilities,

    async connect(): Promise<void> {
      isConnected = true;
      everConnected = true;
    },

    async disconnect(): Promise<void> {
      isConnected = false;
    },

    async send(message: OutboundMessage): Promise<void> {
      if (!bypassLifecycle && !isConnected) {
        throw new Error(`Channel "${channelName}" is not connected`);
      }
      // Default assertion surface: what the caller passed, untouched.
      sent.push(message);
      // Side-channel: the post-downgrade form a real transport would see.
      const rendered: OutboundMessage = {
        ...message,
        content: renderBlocks(message.content, capabilities) as readonly ContentBlock[],
      };
      sentRendered.push(rendered);
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
      // Production `sendStatus()` is a no-op while disconnected.
      if (!bypassLifecycle && !isConnected) return;
      statuses.push(status);
    },
  };

  return {
    adapter,
    sent,
    sentRendered,
    statuses,
    handlerErrors,
    receive: async (message: InboundMessage): Promise<void> => {
      // Setup mistake: receive() called before the test ever connected
      // the channel. Fail loudly — a real transport could not deliver
      // anything pre-connect anyway, and silently returning would mask
      // a missing `await adapter.connect()` in test setup.
      if (!bypassLifecycle && !everConnected) {
        throw new Error(
          `createMockChannel: receive() called before adapter.connect() — missing setup step`,
        );
      }
      // Teardown race: receive() called after an explicit disconnect.
      // Mirror the production adapter's silent drop so tests can model
      // in-flight messages arriving after `disconnect()` without
      // fabricating errors that cannot happen on a real transport.
      if (!bypassLifecycle && !isConnected) {
        return;
      }
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
      // with `failFastOnHandlerError: true`. The fail-fast throw is
      // independent of connection epoch — a concurrent disconnect must
      // NOT silently downgrade an opted-in rejection to a side-channel
      // entry, otherwise the mode is unsound.
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
