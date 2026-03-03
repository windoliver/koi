/**
 * Configuration types for the local IPC (mailbox + router).
 */

import type { AgentId, MailboxComponent } from "@koi/core";

/** Configuration for createLocalMailbox. */
export interface LocalMailboxConfig {
  /** The agent that owns this mailbox. */
  readonly agentId: AgentId;
  /** Maximum messages to retain. Default: 10_000. */
  readonly maxMessages?: number | undefined;
}

/** In-process mailbox router for multi-agent scenarios. */
export interface MailboxRouter {
  /** Register a mailbox for an agent. */
  readonly register: (agentId: AgentId, mailbox: MailboxComponent) => void;
  /** Unregister an agent's mailbox. */
  readonly unregister: (agentId: AgentId) => void;
  /** Get a mailbox by agent ID. */
  readonly get: (agentId: AgentId) => MailboxComponent | undefined;
}
