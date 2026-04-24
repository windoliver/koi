import type { AgentId, AgentMessage, MessageFilter } from "@koi/core";
import {
  clearMailboxRegistration,
  isLocalMailboxInstance,
  isMailboxBoundToRouter,
  recordMailboxRegistration,
} from "./mailbox.js";
import type { LocalMailboxInstance, MailboxRouter, MailboxView } from "./types.js";

// Module-private WeakMap: view object → revoke function. Keeps revocation logic off the
// view's public surface — callers cannot discover or invoke it via reflection.
const viewRevokers = new WeakMap<MailboxView, () => void>();

// Creates a bound, revocable view for a specific mailbox instance. Unlike a live-proxy
// design, this view does not follow re-registration: once revoked (on unregister or
// replacement), list() returns [] predictably and revoked becomes true. Callers who
// need to distinguish "empty mailbox" from "replaced mailbox" check view.revoked and
// call router.getView() again. Only list() is exposed — send, drain, close, and onMessage
// are absent at runtime to prevent destructive cross-agent operations via the router.
function makeRevocableView(mailbox: LocalMailboxInstance): MailboxView {
  const state = { revoked: false };
  const view: MailboxView = Object.freeze({
    get revoked(): boolean {
      return state.revoked;
    },
    list: (filter?: MessageFilter): readonly AgentMessage[] | Promise<readonly AgentMessage[]> => {
      if (state.revoked) return [];
      return mailbox.list(filter);
    },
  });
  viewRevokers.set(view, () => {
    state.revoked = true;
  });
  return view;
}

export function createLocalMailboxRouter(): MailboxRouter {
  // Stores the full LocalMailboxInstance for internal delivery lookups.
  const mailboxes = new Map<string, LocalMailboxInstance>();
  // Stores the current live view per agentId. On unregister/replacement the old view is
  // revoked (its list() returns []) and a new view is created for the new mailbox.
  const views = new Map<string, MailboxView>();

  const self: MailboxRouter = {
    register(agentId: AgentId, mailbox: LocalMailboxInstance): void {
      // Runtime guard: types are erased at runtime, so verify the module-private identity
      // even though the signature already requires LocalMailboxInstance at compile time.
      // This catches JS-only callers, wrong-package instances, and version-skew scenarios.
      if (!isLocalMailboxInstance(mailbox)) {
        throw new Error(
          `createLocalMailboxRouter: only LocalMailbox instances (created by createLocalMailbox) may be registered; custom MailboxComponent implementations are not supported`,
        );
      }
      // Reject mailboxes bound to a different router (or no router at all).
      // A routerless mailbox has no inbound-auth guard, so registering it would
      // allow any caller with a mailbox reference to inject forged-sender messages.
      if (!isMailboxBoundToRouter(mailbox, self)) {
        throw new Error(
          `createLocalMailboxRouter: mailbox for ${mailbox.agentId} was not created with this router. ` +
            `Pass the router at construction time: createLocalMailbox({ agentId: "${mailbox.agentId}", router }) ` +
            `then call router.register(agentId, mailbox). ` +
            `A routerless mailbox or one bound to a different router cannot be registered here. ` +
            `If this error occurs with a correctly constructed mailbox, a duplicate copy of @koi/ipc-local ` +
            `may be loaded in this process — run \`bun dedupe\` or add @koi/ipc-local to peerDependencies.`,
        );
      }
      const bound = mailbox.agentId;
      if (bound !== agentId) {
        throw new Error(
          `createLocalMailboxRouter: cannot register mailbox bound to ${bound} under ${agentId}`,
        );
      }
      // Revoke the previous view (if any) so old handles cannot read from the new mailbox.
      const oldView = views.get(agentId);
      if (oldView !== undefined) {
        viewRevokers.get(oldView)?.();
      }
      mailboxes.set(agentId, mailbox);
      views.set(agentId, makeRevocableView(mailbox));
      // Populate module-private registry in mailbox.ts so outbound routing and the
      // delivery function identity check can access the full mailbox without going
      // through the public getView() (which returns a restricted MailboxView).
      recordMailboxRegistration(self, agentId, mailbox);
    },

    unregister(agentId: AgentId): void {
      // Revoke the view so old handles cannot read from a future re-registration.
      const oldView = views.get(agentId);
      if (oldView !== undefined) {
        viewRevokers.get(oldView)?.();
      }
      mailboxes.delete(agentId);
      views.delete(agentId);
      clearMailboxRegistration(self, agentId);
    },

    getView(agentId: AgentId): MailboxView | undefined {
      // Returns the current view for this agentId. The view is bound to the specific
      // mailbox registered at this moment and is revoked (list() returns []) after
      // unregister or re-registration. Call getView() again after re-registration to
      // obtain a view for the new mailbox.
      return views.get(agentId);
    },

    /** @deprecated Use getView() instead. */
    get(agentId: AgentId): MailboxView | undefined {
      return views.get(agentId);
    },
  };

  return self;
}
