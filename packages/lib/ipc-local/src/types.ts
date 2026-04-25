import type { AgentId, AgentMessage, MailboxComponent } from "@koi/core";

/**
 * Read-only inspection view returned by MailboxRouter.getView().
 * Only list() is exposed — send(), drain(), close(), and onMessage() are absent
 * at both compile time and runtime, preventing any caller with a router reference
 * from draining, closing, or injecting messages into another agent's inbox.
 * The view is bound to the specific mailbox registered when get() was called.
 * After unregister() or re-registration the view is revoked: `revoked` becomes true
 * and list() returns [] predictably. Callers that need to distinguish "empty mailbox"
 * from "revoked view" should check `revoked` before calling list() and call router.getView()
 * to obtain a fresh view for the new mailbox.
 * Cross-agent delivery must go through the sender's own mailbox.send() so the
 * routing-token proof is enforced.
 */
export interface MailboxView {
  readonly list: (
    filter?: import("@koi/core").MessageFilter,
  ) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
  /**
   * True after the underlying mailbox has been unregistered or replaced.
   * When true, list() returns [] — check this flag to distinguish a revoked view
   * from a genuinely empty inbox, then call router.getView() to obtain the new view.
   */
  readonly revoked: boolean;
}

/**
 * The public shape returned by createLocalMailbox.
 * MailboxRouter.register() requires this type so mismatched implementations
 * fail at compile time rather than at runtime.
 */
export interface LocalMailboxInstance extends MailboxComponent {
  readonly agentId: AgentId;
  readonly drain: () => readonly AgentMessage[];
  readonly close: () => void;
}

/** Configuration for createLocalMailbox. */
export interface LocalMailboxConfig {
  readonly agentId: AgentId;
  /** Maximum messages to retain before FIFO eviction. Default: 10_000. Must be >= 1. */
  readonly maxMessages?: number | undefined;
  /**
   * Router for cross-agent delivery.
   *
   * **Required when using `router.register()`**: pass the router here at construction
   * time (`createLocalMailbox({ agentId, router })`), then call `router.register(agentId, mailbox)`.
   * A mailbox created without a router cannot be registered in a router — registration
   * will throw at runtime even though construction succeeds.
   *
   * Without a router, send() accepts all messages into this inbox regardless of the
   * `to` field — useful for isolated single-agent tests.
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
  /**
   * Register a mailbox for an agent.
   * Only a `LocalMailboxInstance` produced by `createLocalMailbox({ agentId, router: this })`
   * is accepted — this is enforced at compile time by the type and at runtime by the
   * module-private WeakMap identity check.
   */
  readonly register: (agentId: AgentId, mailbox: LocalMailboxInstance) => void;
  readonly unregister: (agentId: AgentId) => void;
  /**
   * Returns a read-only view of the registered mailbox, or undefined if not registered.
   * The view only exposes list() and revoked — send, drain, close, and onMessage are absent
   * at runtime to prevent destructive cross-agent operations via the router reference.
   * After unregister() or re-registration the view is revoked: `revoked` becomes true and
   * list() returns [] predictably. Call getView() again to obtain a fresh view.
   */
  readonly getView: (agentId: AgentId) => MailboxView | undefined;
  /**
   * @deprecated Use getView() instead. Returns the same read-only MailboxView as getView().
   * The returned object only exposes list() and revoked — send(), drain(), close(), and
   * onMessage() are intentionally absent to prevent cross-agent write access via the router.
   */
  readonly get: (agentId: AgentId) => MailboxView | undefined;
}
