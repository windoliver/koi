/**
 * @koi/channel-ide — IDE channel adapter (L2).
 *
 * Newline-delimited JSON-RPC frames over an injected duplex transport. Editor
 * plugins translate to/from native APIs; this package is pure protocol glue.
 */

export type { IdeChannelConfig, IdeTransport } from "./ide-channel.js";
export { createIdeChannel } from "./ide-channel.js";
