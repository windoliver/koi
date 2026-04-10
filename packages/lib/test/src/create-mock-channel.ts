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
}

export interface MockChannelResult {
  readonly adapter: ChannelAdapter;
  readonly sent: readonly OutboundMessage[];
  readonly statuses: readonly ChannelStatus[];
  /** Simulate an inbound message. Throws if no handler is registered. */
  readonly receive: (message: InboundMessage) => Promise<void>;
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

export function createMockChannel(config?: MockChannelConfig): MockChannelResult {
  const sent: OutboundMessage[] = [];
  const statuses: ChannelStatus[] = [];
  let handler: MessageHandler | undefined;
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
      handler = h;
      return (): void => {
        if (handler === h) {
          handler = undefined;
        }
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
    receive: async (message: InboundMessage): Promise<void> => {
      if (handler === undefined) {
        throw new Error(
          "createMockChannel: receive() called before onMessage() registered a handler",
        );
      }
      await handler(message);
    },
    connected: (): boolean => isConnected,
  };
}
