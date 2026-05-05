import { createChannelAdapter } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  InboundMessage,
  OutboundMessage,
} from "@koi/core";

/** Duplex line-oriented transport (TCP socket, stdio pair, named pipe, etc.). */
export interface IdeTransport {
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly send: (line: string) => Promise<void>;
  /** Subscribe to inbound lines. Returns unsubscribe. */
  readonly onLine: (handler: (line: string) => void) => () => void;
}

export interface IdeChannelConfig {
  readonly transport: IdeTransport;
  readonly senderId?: string;
}

const IDE_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: false,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
};

interface NotifyParams {
  readonly content?: readonly ContentBlock[];
  readonly senderId?: string;
  readonly threadId?: string;
}

interface NotifyFrame {
  readonly jsonrpc: "2.0";
  readonly method: "notify";
  readonly params?: NotifyParams;
}

function parseFrame(line: string): NotifyFrame | null {
  try {
    const v = JSON.parse(line) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const obj = v as Record<string, unknown>;
    if (obj.jsonrpc !== "2.0" || obj.method !== "notify") return null;
    return obj as unknown as NotifyFrame;
  } catch {
    return null;
  }
}

export function createIdeChannel(config: IdeChannelConfig): ChannelAdapter {
  const defaultSenderId = config.senderId ?? "ide-user";

  return createChannelAdapter<string>({
    name: "ide",
    capabilities: IDE_CAPABILITIES,
    platformConnect: () => config.transport.connect(),
    platformDisconnect: () => config.transport.disconnect(),
    platformSend: async (message: OutboundMessage) => {
      const frame: NotifyFrame = {
        jsonrpc: "2.0",
        method: "notify",
        params: {
          content: message.content,
          ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
        },
      };
      await config.transport.send(JSON.stringify(frame));
    },
    onPlatformEvent: (handler) => config.transport.onLine(handler),
    normalize: (line: string): InboundMessage | null => {
      const frame = parseFrame(line);
      if (frame === null) return null;
      const params = frame.params ?? {};
      const content = params.content ?? [];
      if (content.length === 0) return null;
      return {
        content,
        senderId: params.senderId ?? defaultSenderId,
        timestamp: Date.now(),
        ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
      };
    },
  });
}
