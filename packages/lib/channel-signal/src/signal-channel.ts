/**
 * @koi/channel-signal — signal-cli ChannelAdapter factory.
 */

import { createChannelAdapter } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  InboundMessage,
  OutboundMessage,
} from "@koi/core";
import { isE164 } from "./e164.js";
import { createNormalizer, GROUP_THREAD_PREFIX } from "./normalize.js";
import type { SignalEvent, SignalProcess, SpawnFn } from "./signal-process.js";
import { createSignalProcess, SIGNAL_SHUTDOWN_TIMEOUT_MS } from "./signal-process.js";

export interface SignalChannelConfig {
  readonly account: string;
  readonly signalCliPath?: string;
  readonly configPath?: string;
  /**
   * Subprocess launcher. Defaults to a `Bun.spawn`-backed implementation.
   * Tests inject a fake to avoid touching the real signal-cli binary.
   */
  readonly spawn?: SpawnFn;
  /**
   * Called when the signal-cli subprocess exits unexpectedly (crash,
   * external SIGKILL, etc.). The adapter has already been marked
   * disconnected internally; consumers can use this hook to trigger a
   * reconnect, surface a user-visible error, or alert.
   */
  readonly onUnexpectedExit?: () => void;
  /**
   * Invoked when an inbound `MessageHandler` registered via `onMessage()`
   * throws or rejects. Without this, dispatch failures are swallowed by
   * the adapter's `Promise.allSettled` ingress loop and the inbound
   * message disappears silently. Wire to your logger / DLQ / pager.
   */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
}

/**
 * Default `SpawnFn` backed by `Bun.spawn`. Wires the subprocess's stdout,
 * stdin (writable FileSink), exited promise, and kill into the
 * `SignalChildProcess` shape the manager expects.
 *
 * Bun-only: the koi monorepo targets Bun 1.3+ (see project CLAUDE.md). On
 * Node or other runtimes, callers must inject their own `SpawnFn`. We fail
 * fast at construction with a clear message rather than crashing later when
 * a `Bun` global is dereferenced.
 */
export const defaultSignalSpawn: SpawnFn = (cmd) => {
  if (typeof globalThis.Bun === "undefined") {
    throw new Error(
      "[channel-signal] defaultSignalSpawn requires the Bun runtime. Pass a Node-compatible SpawnFn (e.g. child_process.spawn-based) via SignalChannelConfig.spawn.",
    );
  }
  const proc = Bun.spawn([...cmd], { stdin: "pipe", stdout: "pipe" });
  const stdin = proc.stdin;
  if (stdin === undefined) {
    throw new Error("[channel-signal] Bun.spawn produced no stdin handle");
  }
  return {
    stdout: proc.stdout,
    stdin: {
      write: (data: Uint8Array): void => {
        stdin.write(data);
        stdin.flush();
      },
    },
    exited: proc.exited,
    kill: (signal?: number): void => {
      proc.kill(signal);
    },
  };
};

const SIGNAL_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
};

const SIGNAL_TEXT_LIMIT = 4000;

export function createSignalChannel(config: SignalChannelConfig): ChannelAdapter {
  if (!isE164(config.account)) {
    throw new Error(
      `[channel-signal] account must be an E.164 phone number, got "${config.account}"`,
    );
  }

  // let requires justification: assigned after adapter construction so the
  // unexpected-exit handler (which fires after start()) can drive the
  // adapter's lifecycle by calling disconnect().
  let adapter: ChannelAdapter | undefined;

  const onUnexpectedExit = (): void => {
    // Transport died after a successful start. Force the channel out of
    // its connected state so the runtime stops trusting it and inbound
    // ingress loss becomes observable instead of silent. Errors during
    // teardown go to stderr because there is no well-defined caller hook
    // at this point in the lifecycle (the user's callback is invoked
    // separately, below, for any reconnect logic).
    adapter?.disconnect().catch((err: unknown) => {
      console.error("[channel-signal] disconnect after unexpected exit failed:", err);
    });
    config.onUnexpectedExit?.();
  };

  const proc: SignalProcess = createSignalProcess(
    config.account,
    config.signalCliPath ?? "signal-cli",
    config.configPath,
    config.spawn ?? defaultSignalSpawn,
    SIGNAL_SHUTDOWN_TIMEOUT_MS,
    onUnexpectedExit,
  );
  const normalize = createNormalizer();

  adapter = createChannelAdapter<SignalEvent>({
    name: "signal",
    capabilities: SIGNAL_CAPABILITIES,

    platformConnect: async (): Promise<void> => {
      await proc.start();
    },

    platformDisconnect: async (): Promise<void> => {
      await proc.stop();
    },

    platformSend: async (message: OutboundMessage): Promise<void> => {
      await sendOutbound(proc, config.account, message);
    },

    onPlatformEvent: (handler): (() => void) => proc.onEvent(handler),

    normalize,

    ...(config.onHandlerError !== undefined && { onHandlerError: config.onHandlerError }),
  });

  return adapter;
}

async function sendOutbound(
  proc: SignalProcess,
  account: string,
  message: OutboundMessage,
): Promise<void> {
  if (message.threadId === undefined) {
    throw new Error("[channel-signal] OutboundMessage.threadId is required");
  }

  const body = blocksToText(message.content);
  if (body.length === 0) return;

  const chunks = splitText(body, SIGNAL_TEXT_LIMIT);
  const isGroup = message.threadId.startsWith(GROUP_THREAD_PREFIX);
  const target = isGroup ? message.threadId.slice(GROUP_THREAD_PREFIX.length) : message.threadId;
  if (!isGroup && !isE164(target)) {
    throw new Error(
      `[channel-signal] DM threadId must be E.164, got "${target}". Use "group:<id>" for groups.`,
    );
  }

  // let requires justification: counts chunks that successfully went out
  // so we can escalate to a typed partial-delivery error after the first
  // success. Without this, a transient failure on chunk 2 looks like a
  // total failure to retry middleware, which would resend chunk 1 and
  // duplicate it in the recipient's chat.
  let delivered = 0;
  for (const chunk of chunks) {
    const params: Record<string, unknown> = isGroup
      ? { account, message: chunk, groupId: target }
      : { account, message: chunk, recipient: target };
    try {
      await proc.send({ method: "send", params });
      delivered++;
    } catch (err: unknown) {
      if (delivered === 0) throw err;
      throw new SignalPartialDeliveryError(delivered, err);
    }
  }
}

/**
 * Thrown when a multi-chunk Signal send fails after at least one chunk
 * has already been delivered. Retry/queue middleware should detect this
 * error class and NOT blindly retry the same `OutboundMessage` —
 * doing so would duplicate the already-sent chunks in the recipient's
 * chat. Surface to the caller so they can compose a manual recovery
 * (resend only the missing tail) or accept partial delivery.
 */
export class SignalPartialDeliveryError extends Error {
  readonly deliveredParts: number;
  override readonly cause: unknown;
  constructor(deliveredParts: number, cause: unknown) {
    super(
      `[channel-signal] partial delivery: ${deliveredParts} chunk(s) sent before failure; retrying the same OutboundMessage will duplicate them`,
    );
    this.name = "SignalPartialDeliveryError";
    this.deliveredParts = deliveredParts;
    this.cause = cause;
  }
}

/** Flattens ContentBlocks to a Signal message body. Non-text blocks become [bracketed] hints. */
export function blocksToText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "text":
        parts.push(b.text);
        break;
      case "image":
        parts.push(`[Image: ${b.alt ?? b.url}]`);
        break;
      case "file":
        parts.push(`[File: ${b.name ?? b.url}]`);
        break;
      case "button":
        parts.push(`[${b.label}]`);
        break;
      case "custom":
        // skip
        break;
    }
  }
  return parts.join("\n");
}

export function splitText(s: string, limit: number): readonly string[] {
  if (s.length <= limit) return [s];
  const out: string[] = [];
  // let requires justification: walks the input slicing into <= limit chunks
  let rest = s;
  while (rest.length > limit) {
    const breakAt = rest.lastIndexOf("\n", limit);
    const cut = breakAt > limit / 2 ? breakAt : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
}
