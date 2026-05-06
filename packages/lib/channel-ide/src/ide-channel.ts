import { createChannelAdapter } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  InboundMessage,
  OutboundMessage,
} from "@koi/core";

/**
 * Duplex line-oriented transport (TCP socket, stdio pair, named pipe, etc.).
 *
 * The string passed to `send()` is the **already-framed** payload — it
 * includes the trailing `\n` delimiter. The transport writes it verbatim;
 * delimiter insertion is the channel's responsibility, not the transport's.
 * Inbound `onLine` callbacks receive one delimited line per invocation
 * (the `\n` already stripped by the transport's line splitter).
 */
export interface IdeTransport {
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly send: (framed: string) => Promise<void>;
  /** Subscribe to inbound lines (delimiter already stripped). Returns unsubscribe. */
  readonly onLine: (handler: (line: string) => void) => () => void;
}

export interface IdeChannelConfig {
  readonly transport: IdeTransport;
  readonly senderId?: string;
  /**
   * Trust client-supplied `senderId`/`threadId` from inbound `notify.params`.
   * Default `false`: client-supplied identity/routing metadata is dropped and
   * replaced with the host-configured `senderId`. Set `true` only when the
   * transport itself authenticates and binds a single trusted editor session.
   */
  readonly trustClientIdentity?: boolean;
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
  const trustClient = config.trustClientIdentity === true;

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
      // Append the frame delimiter here so back-to-back sends never
      // concatenate to "}{" on a raw byte stream that does not insert
      // delimiters itself.
      await config.transport.send(`${JSON.stringify(frame)}\n`);
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
        senderId: trustClient ? (params.senderId ?? defaultSenderId) : defaultSenderId,
        timestamp: Date.now(),
        ...(trustClient && params.threadId !== undefined ? { threadId: params.threadId } : {}),
      };
    },
  });
}
