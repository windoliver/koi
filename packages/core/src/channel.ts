/**
 * Channel adapter contract — I/O interface to users.
 */

import type { InboundMessage, OutboundMessage } from "./message.js";

export interface ChannelCapabilities {
  readonly text: boolean;
  readonly images: boolean;
  readonly files: boolean;
  readonly buttons: boolean;
  readonly audio: boolean;
  readonly video: boolean;
  readonly threads: boolean;
}

export type MessageHandler = (message: InboundMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly send: (message: OutboundMessage) => Promise<void>;
  readonly onMessage: (handler: MessageHandler) => () => void;
}
