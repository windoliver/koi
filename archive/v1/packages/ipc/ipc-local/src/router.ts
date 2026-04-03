/**
 * Local in-process mailbox router.
 *
 * Routes messages between multiple LocalMailbox instances in the same process.
 * Maps AgentId → MailboxComponent for delivery routing.
 */

import type { AgentId, MailboxComponent } from "@koi/core";
import type { MailboxRouter } from "./types.js";

/**
 * Create a local mailbox router for in-process multi-agent messaging.
 */
export function createLocalMailboxRouter(): MailboxRouter {
  const mailboxes = new Map<string, MailboxComponent>();

  return {
    register(agentId: AgentId, mailbox: MailboxComponent): void {
      mailboxes.set(agentId, mailbox);
    },

    unregister(agentId: AgentId): void {
      mailboxes.delete(agentId);
    },

    get(agentId: AgentId): MailboxComponent | undefined {
      return mailboxes.get(agentId);
    },
  };
}
