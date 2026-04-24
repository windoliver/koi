import type { AgentId, MailboxComponent } from "@koi/core";

/** Configuration for createLocalMailbox. */
export interface LocalMailboxConfig {
  readonly agentId: AgentId;
  /** Maximum messages to retain before FIFO eviction. Default: 10_000. Must be >= 1. */
  readonly maxMessages?: number | undefined;
  /**
   * Optional router for cross-agent delivery. When provided, send() forwards
   * messages addressed to other agents through the router. Without a router,
   * send() accepts all messages into this inbox (useful for test helpers).
   */
  readonly router?: MailboxRouter | undefined;
  /**
   * Optional error observer for subscriber failures. Called when a subscriber
   * throws synchronously or rejects an async handler. Provides observability
   * without breaking delivery isolation.
   */
  readonly onError?:
    | ((error: unknown, message: import("@koi/core").AgentMessage) => void)
    | undefined;
}

/** In-process mailbox router for multi-agent scenarios. */
export interface MailboxRouter {
  readonly register: (agentId: AgentId, mailbox: MailboxComponent) => void;
  readonly unregister: (agentId: AgentId) => void;
  readonly get: (agentId: AgentId) => MailboxComponent | undefined;
}
