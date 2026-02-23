/**
 * Channel adapter contract — I/O interface to users.
 */

import type { JsonObject } from "./common.js";
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

export type ChannelStatusKind = "processing" | "idle" | "error";

export interface ChannelStatus {
  readonly kind: ChannelStatusKind;
  readonly turnIndex: number;
  /** Correlates to the inbound message that triggered this turn. */
  readonly messageRef?: string;
  /** Human-readable hint for rich UIs: "thinking", "calling search", etc. */
  readonly detail?: string;
  readonly metadata?: JsonObject;
}

export interface ChannelAdapter {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly send: (message: OutboundMessage) => Promise<void>;
  readonly onMessage: (handler: MessageHandler) => () => void;
  readonly sendStatus?: (status: ChannelStatus) => Promise<void>;
}
