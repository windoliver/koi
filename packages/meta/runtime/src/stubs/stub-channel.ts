import type {
  ChannelAdapter,
  ChannelCapabilities,
  MessageHandler,
  OutboundMessage,
} from "@koi/core";

/**
 * Stub channel adapter that accepts messages but does nothing.
 * Implements the full ChannelAdapter contract with no-op behavior.
 * Replaced by @koi/channel-cli when that package lands.
 */
export function createStubChannel(): ChannelAdapter {
  return {
    name: "stub",
    capabilities: STUB_CHANNEL_CAPABILITIES,
    connect: async () => {},
    disconnect: async () => {},
    send: async (_message: OutboundMessage) => {},
    onMessage: (_handler: MessageHandler) => {
      // No-op — stub never receives messages
      return () => {};
    },
  };
}

const STUB_CHANNEL_CAPABILITIES: ChannelCapabilities = Object.freeze({
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
});
