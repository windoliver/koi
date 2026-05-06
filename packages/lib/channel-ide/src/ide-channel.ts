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
  readonly content?: readonly unknown[];
  readonly senderId?: string;
  readonly threadId?: string;
}

interface NotifyFrame {
  readonly jsonrpc: "2.0";
  readonly method: "notify";
  readonly params?: NotifyParams;
}

/** Bound memory from a buggy or compromised editor plugin. */
const MAX_INBOUND_FRAME_BYTES = 256 * 1024;

function validateContentBlock(value: unknown): ContentBlock | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "text":
      return typeof v.text === "string" ? (value as ContentBlock) : null;
    case "file":
      return typeof v.url === "string" &&
        typeof v.mimeType === "string" &&
        (v.name === undefined || typeof v.name === "string")
        ? (value as ContentBlock)
        : null;
    case "image":
      return typeof v.url === "string" && (v.alt === undefined || typeof v.alt === "string")
        ? (value as ContentBlock)
        : null;
    case "button":
      return typeof v.label === "string" && typeof v.action === "string"
        ? (value as ContentBlock)
        : null;
    case "custom":
      return typeof v.type === "string" ? (value as ContentBlock) : null;
    default:
      return null;
  }
}

function validateContentBlocks(value: readonly unknown[]): readonly ContentBlock[] | null {
  const out: ContentBlock[] = [];
  for (const item of value) {
    const valid = validateContentBlock(item);
    if (valid === null) return null;
    out.push(valid);
  }
  return out;
}

function parseFrame(line: string): NotifyFrame | null {
  // UTF-8 byte length, not string.length (UTF-16 code units), so multi-
  // byte payloads (CJK, emoji at 4 bytes/char) cannot stay under the
  // code-unit limit while busting the documented byte cap and force the
  // adapter to allocate an oversized JSON parse.
  if (Buffer.byteLength(line, "utf8") > MAX_INBOUND_FRAME_BYTES) return null;
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
      const rawContent = params.content ?? [];
      if (!Array.isArray(rawContent) || rawContent.length === 0) return null;
      // Reject any frame containing a malformed ContentBlock — never smuggle
      // untyped editor-plugin objects into downstream handlers.
      const content = validateContentBlocks(rawContent);
      if (content === null) return null;
      // trustClientIdentity-mode: a buggy or compromised plugin could
      // emit non-string senderId/threadId values. The InboundMessage
      // contract requires strings, so smuggling a number / object / null
      // through would corrupt downstream routing and serialization. Drop
      // the frame entirely if either field is present-but-malformed; an
      // absent field is fine and falls back to defaults.
      // let requires justification: validated identity vars
      let trustedSender: string | undefined;
      let trustedThread: string | undefined;
      if (trustClient) {
        if (params.senderId !== undefined) {
          if (typeof params.senderId !== "string" || params.senderId.length === 0) return null;
          trustedSender = params.senderId;
        }
        if (params.threadId !== undefined) {
          if (typeof params.threadId !== "string" || params.threadId.length === 0) return null;
          trustedThread = params.threadId;
        }
      }
      return {
        content,
        senderId: trustClient ? (trustedSender ?? defaultSenderId) : defaultSenderId,
        timestamp: Date.now(),
        ...(trustedThread !== undefined ? { threadId: trustedThread } : {}),
      };
    },
  });
}
