/**
 * @koi/channel-signal — Signal ChannelAdapter (L2).
 */

export { isE164, normalizeE164 } from "./e164.js";
export { createNormalizer, GROUP_THREAD_PREFIX } from "./normalize.js";
export type { SignalChannelConfig } from "./signal-channel.js";
export { blocksToText, createSignalChannel, splitText } from "./signal-channel.js";
export type {
  SignalAttachment,
  SignalChildProcess,
  SignalCommand,
  SignalEvent,
  SignalProcess,
  SpawnFn,
} from "./signal-process.js";
export {
  createSignalProcess,
  parseEvent,
  SIGNAL_SHUTDOWN_TIMEOUT_MS,
} from "./signal-process.js";
