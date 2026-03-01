/**
 * @koi/ipc-nexus — Agent-to-agent messaging via Nexus IPC (Layer 2)
 *
 * Provides a ComponentProvider that wraps a MailboxComponent backed by
 * the Nexus REST API. Agents can send messages, subscribe to incoming
 * messages, and list their inbox.
 *
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 */

// types — re-exported from @koi/core for convenience
export type {
  AgentMessage,
  AgentMessageInput,
  MailboxComponent,
  MessageFilter,
  MessageId,
  MessageKind,
} from "@koi/core";

// domain-specific types
export type { IpcOperation } from "./constants.js";

// constants
export { DEFAULT_PREFIX, OPERATIONS } from "./constants.js";
// adapter
export type { NexusMailboxConfig } from "./mailbox-adapter.js";
export { createNexusMailbox } from "./mailbox-adapter.js";
// provider
export type { IpcNexusProviderConfig } from "./mailbox-provider.js";
export { createIpcNexusProvider } from "./mailbox-provider.js";
// tool factories — for advanced usage (custom tool composition)
export { createDiscoverTool } from "./tools/discover.js";
export { createListTool } from "./tools/list.js";
export { createSendTool } from "./tools/send.js";
