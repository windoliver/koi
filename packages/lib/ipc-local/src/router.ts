import type { AgentId, MailboxComponent } from "@koi/core";
import type { MailboxRouter } from "./types.js";

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
