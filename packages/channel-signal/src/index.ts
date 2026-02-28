/**
 * @koi/channel-signal — signal-cli subprocess channel adapter.
 *
 * Creates a ChannelAdapter that communicates via signal-cli's JSON-RPC mode.
 * Requires signal-cli binary and Java runtime installed on the system.
 *
 * @example
 * ```typescript
 * import { createSignalChannel } from "@koi/channel-signal";
 *
 * const channel = createSignalChannel({
 *   account: "+1234567890",
 * });
 * await channel.connect();
 * ```
 */

export type { SignalChannelConfig, SpawnFn } from "./config.js";
export { DEFAULT_SIGNAL_DEBOUNCE_MS, SIGNAL_SHUTDOWN_TIMEOUT_MS } from "./config.js";
export { descriptor } from "./descriptor.js";
export { isE164, normalizeE164 } from "./e164.js";
export { createSignalChannel } from "./signal-channel.js";
export type {
  SignalAttachment,
  SignalCommand,
  SignalEvent,
  SignalProcess,
} from "./signal-process.js";
