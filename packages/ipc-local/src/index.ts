/**
 * @koi/ipc-local — Local in-memory IPC (mailbox + router) (Layer 2).
 *
 * Provides a MailboxComponent backed by in-memory storage with microtask
 * dispatch, plus a MailboxRouter for multi-agent in-process communication.
 */

export { createLocalMailbox } from "./mailbox.js";
export { createLocalMailboxRouter } from "./router.js";
export type { LocalMailboxConfig, MailboxRouter } from "./types.js";
