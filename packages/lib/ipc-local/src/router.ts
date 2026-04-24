import type { AgentId, MailboxComponent } from "@koi/core";
import type { MailboxRouter } from "./types.js";

export function createLocalMailboxRouter(): MailboxRouter {
  const mailboxes = new Map<string, MailboxComponent>();

  return {
    register(agentId: AgentId, mailbox: MailboxComponent): void {
      // Guard against registering a mailbox under the wrong agent ID.
      // LocalMailbox exposes its bound agentId; validate it matches.
      const bound = (mailbox as Partial<{ readonly agentId: AgentId }>).agentId;
      if (bound !== undefined && bound !== agentId) {
        throw new Error(
          `createLocalMailboxRouter: cannot register mailbox bound to ${bound} under ${agentId}`,
        );
      }
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
