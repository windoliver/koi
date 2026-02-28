/**
 * Factory for the Signal channel adapter.
 *
 * Uses signal-cli subprocess in JSON-RPC mode to send/receive messages.
 * Supports DMs and group messages, with debouncing for rapid messages.
 */

import { createChannelAdapter, createDebouncer } from "@koi/channel-base";
import type { ChannelCapabilities } from "@koi/core";
import type { SignalChannelConfig, SpawnFn } from "./config.js";
import { DEFAULT_SIGNAL_DEBOUNCE_MS } from "./config.js";
import { createNormalizer } from "./normalize.js";
import { createPlatformSend } from "./platform-send.js";
import type { SignalEvent } from "./signal-process.js";
import { createSignalProcess } from "./signal-process.js";

const SIGNAL_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

/**
 * Creates a Signal channel adapter backed by signal-cli subprocess.
 *
 * The subprocess is lazily started on connect() and kept running
 * across reconnects. Graceful shutdown sends SIGTERM with a 5s timeout.
 */
export function createSignalChannel(
  config: SignalChannelConfig,
): ReturnType<typeof createChannelAdapter> {
  const account = config.account;
  const signalCliPath = config.signalCliPath ?? "signal-cli";
  const debounceMs = config.debounceMs ?? DEFAULT_SIGNAL_DEBOUNCE_MS;

  const spawnFn = config._spawn ?? defaultSpawn;
  const signalProcess = createSignalProcess(account, signalCliPath, config.configPath, spawnFn);

  const debouncer = debounceMs > 0 ? createDebouncer({ windowMs: debounceMs }) : undefined;

  const base = createChannelAdapter<SignalEvent>({
    name: "signal",
    capabilities: SIGNAL_CAPABILITIES,

    platformConnect: async (): Promise<void> => {
      await signalProcess.start();
    },

    platformDisconnect: async (): Promise<void> => {
      debouncer?.dispose();
      await signalProcess.stop();
    },

    platformSend: createPlatformSend(signalProcess, account),

    onPlatformEvent: (handler: (event: SignalEvent) => void): (() => void) => {
      return signalProcess.onEvent(handler);
    },

    normalize: createNormalizer(),

    ...(config.onHandlerError !== undefined ? { onHandlerError: config.onHandlerError } : {}),
    ...(config.queueWhenDisconnected !== undefined
      ? { queueWhenDisconnected: config.queueWhenDisconnected }
      : {}),
  });

  return base;
}

/** Default spawn implementation using Bun.spawn. */
function defaultSpawn(cmd: readonly string[]): ReturnType<SpawnFn> {
  const proc = Bun.spawn(cmd as string[], {
    stdout: "pipe",
    stdin: "pipe",
  });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stdin: { write: (data: Uint8Array) => proc.stdin.write(data) },
    kill: (signal?: number) => proc.kill(signal),
    exited: proc.exited,
  };
}
