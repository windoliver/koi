/**
 * Configuration types for @koi/channel-signal.
 */

import type { InboundMessage } from "@koi/core";

/** Type for the spawn function injected for testing. */
export type SpawnFn = (cmd: readonly string[]) => {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stdin: { readonly write: (data: Uint8Array) => number | Promise<number> };
  readonly kill: (signal?: number) => void;
  readonly exited: Promise<number>;
};

/** Configuration for the Signal channel adapter. */
export interface SignalChannelConfig {
  /** Signal account phone number (e.g., "+1234567890"). */
  readonly account: string;
  /** Path to signal-cli binary. Default: "signal-cli" */
  readonly signalCliPath?: string;
  /** signal-cli config directory. */
  readonly configPath?: string;
  /** Debounce window for rapid messages in ms. Default: 500 */
  readonly debounceMs?: number;
  /** Error handler for message processing failures. */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
  /** Queue outbound messages when disconnected. Default: false */
  readonly queueWhenDisconnected?: boolean;
  /** @internal Test injection for Bun.spawn. */
  readonly _spawn?: SpawnFn;
}

/** Default debounce window in milliseconds. */
export const DEFAULT_SIGNAL_DEBOUNCE_MS = 500;
/** Graceful shutdown timeout before SIGKILL in milliseconds. */
export const SIGNAL_SHUTDOWN_TIMEOUT_MS = 5_000;
