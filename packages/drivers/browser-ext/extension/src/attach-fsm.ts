import type {
  NmAttach,
  NmAttachAckFail,
  NmAttachAckOk,
  NmDetached,
} from "../../src/native-host/nm-frame.js";
import { type CleanupPendingManager, createCleanupPendingManager } from "./cleanup-pending.js";
import type { ConsentManager } from "./consent.js";
import { createDetachedFrame, detachDebugger } from "./detach-helpers.js";
import { getMainFrameDocument } from "./document-id.js";
import { isOriginAllowedByPolicy } from "./private-origin.js";
import type { ExtensionStorage } from "./storage.js";

export interface Participant {
  readonly leaseToken: string;
  readonly attachRequestId: string;
}

interface PendingConsentState {
  readonly phase: "pending_consent";
  readonly documentId: string;
  readonly origin: string;
  readonly participants: readonly Participant[];
  readonly startedAt: number;
}

interface AttachingState {
  readonly phase: "attaching";
  readonly documentId: string;
  readonly origin: string;
  readonly clientId: string;
  readonly participants: readonly Participant[];
  readonly startedAt: number;
  readonly attachPromise: Promise<boolean>;
}

export interface AttachedState {
  readonly phase: "attached";
  readonly tabId: number;
  readonly documentId: string;
  readonly origin: string;
  readonly clientId: string;
  readonly sessionId: string;
  readonly attachedAt: number;
}

type TabState = PendingConsentState | AttachingState | AttachedState;

export interface AttachFsm {
  readonly handleAttach: (frame: NmAttach) => Promise<void>;
  readonly handleDetachRequest: (frame: {
    readonly tabId: number;
    readonly sessionId: string;
  }) => Promise<void>;
  readonly handleAbandonAttach: (leaseToken: string) => Promise<readonly number[]>;
  readonly handleTabRemoved: (tabId: number) => Promise<void>;
  readonly handleCommittedNavigation: (details: {
    readonly tabId: number;
    readonly frameId: number;
    readonly documentId?: string;
    readonly url?: string;
  }) => Promise<void>;
  readonly handleHostDisconnect: () => Promise<void>;
  readonly getAttachedStateBySessionId: (sessionId: string) => AttachedState | null;
  readonly getAttachedStates: () => readonly AttachedState[];
  readonly getClaimedTabIds: () => readonly number[];
}

function createFailure(frame: NmAttach, reason: NmAttachAckFail["reason"]): NmAttachAckFail {
  return {
    kind: "attach_ack",
    ok: false,
    tabId: frame.tabId,
    leaseToken: frame.leaseToken,
    attachRequestId: frame.attachRequestId,
    reason,
  };
}

function createSuccess(frame: NmAttach, sessionId: string): NmAttachAckOk {
  return {
    kind: "attach_ack",
    ok: true,
    tabId: frame.tabId,
    leaseToken: frame.leaseToken,
    attachRequestId: frame.attachRequestId,
    sessionId,
  };
}

function dedupeParticipants(
  participants: readonly Participant[],
  participant: Participant,
): readonly Participant[] {
  if (
    participants.some(
      (value) =>
        value.leaseToken === participant.leaseToken &&
        value.attachRequestId === participant.attachRequestId,
    )
  ) {
    return participants;
  }
  return [...participants, participant];
}

export function createAttachFsm(deps: {
  readonly storage: ExtensionStorage;
  readonly consent: ConsentManager;
  readonly sendFrame: (
    frame:
      | NmAttachAckOk
      | NmAttachAckFail
      | NmDetached
      | {
          readonly kind: "detach_ack";
          readonly sessionId: string;
          readonly tabId: number;
          readonly ok: boolean;
          readonly reason?: "not_attached" | "chrome_error";
        },
  ) => void;
}): AttachFsm {
  const tabStates = new Map<number, TabState>();
  const sessionToTab = new Map<string, number>();

  const cleanupPending: CleanupPendingManager = createCleanupPendingManager({
    runAttach: async (frame) => {
      await handleAttach(frame);
    },
    failAttach: (frame, reason) => deps.sendFrame(createFailure(frame, reason)),
    advisoryDetach: async (tabId) => {
      await detachDebugger(tabId);
    },
  });

  async function transitionToAttaching(
    frame: NmAttach,
    documentId: string,
    origin: string,
    participants: readonly Participant[],
  ): Promise<void> {
    const startedAt = Date.now();
    const clientId = participants[0]?.leaseToken ?? frame.leaseToken;
    const attachPromise = (async (): Promise<boolean> => {
      try {
        await (
          chrome.debugger.attach as unknown as (
            target: chrome.debugger.Debuggee,
            version: string,
          ) => Promise<void>
        )({ tabId: frame.tabId }, "1.3");
      } catch {
        const current = tabStates.get(frame.tabId);
        if (current?.phase === "attaching" && current.startedAt === startedAt) {
          tabStates.delete(frame.tabId);
          for (const participant of current.participants) {
            deps.sendFrame(
              createFailure(
                {
                  kind: "attach",
                  tabId: frame.tabId,
                  leaseToken: participant.leaseToken,
                  attachRequestId: participant.attachRequestId,
                },
                "already_attached",
              ),
            );
          }
        }
        return false;
      }

      const current = tabStates.get(frame.tabId);
      if (current?.phase !== "attaching" || current.startedAt !== startedAt) {
        return true;
      }

      const sessionId = crypto.randomUUID();
      const attachedState: AttachedState = {
        phase: "attached",
        tabId: frame.tabId,
        documentId,
        origin,
        clientId,
        sessionId,
        attachedAt: Date.now(),
      };
      tabStates.set(frame.tabId, attachedState);
      sessionToTab.set(sessionId, frame.tabId);
      for (const participant of current.participants) {
        deps.sendFrame(
          createSuccess(
            {
              kind: "attach",
              tabId: frame.tabId,
              leaseToken: participant.leaseToken,
              attachRequestId: participant.attachRequestId,
            },
            sessionId,
          ),
        );
      }
      return true;
    })();

    tabStates.set(frame.tabId, {
      phase: "attaching",
      documentId,
      origin,
      clientId,
      participants,
      startedAt,
      attachPromise,
    });
    await attachPromise;
  }

  async function handleAttach(frame: NmAttach): Promise<void> {
    if (cleanupPending.enqueue(frame)) return;

    const currentDocument = await getMainFrameDocument(frame.tabId);
    if (!currentDocument) {
      deps.sendFrame(createFailure(frame, "tab_closed"));
      return;
    }

    const allowedByPolicy = await isOriginAllowedByPolicy(deps.storage, currentDocument.origin);
    if (!allowedByPolicy) {
      deps.sendFrame(createFailure(frame, "private_origin"));
      return;
    }

    const existing = tabStates.get(frame.tabId);
    if (existing?.phase === "attached") {
      if (existing.clientId === frame.leaseToken) {
        deps.sendFrame(createSuccess(frame, existing.sessionId));
      } else {
        deps.sendFrame({
          ...createFailure(frame, "already_attached"),
          currentOwner: {
            clientId: existing.clientId,
            since: new Date(existing.attachedAt).toISOString(),
          },
        });
      }
      return;
    }

    if (existing?.phase === "pending_consent") {
      const nextParticipants = dedupeParticipants(existing.participants, {
        leaseToken: frame.leaseToken,
        attachRequestId: frame.attachRequestId,
      });
      tabStates.set(frame.tabId, { ...existing, participants: nextParticipants });
      return;
    }

    if (existing?.phase === "attaching") {
      const nextParticipants = dedupeParticipants(existing.participants, {
        leaseToken: frame.leaseToken,
        attachRequestId: frame.attachRequestId,
      });
      tabStates.set(frame.tabId, { ...existing, participants: nextParticipants });
      return;
    }

    const alwaysGrants = await deps.storage.getAlwaysGrants();
    const hasAlwaysGrant = alwaysGrants[currentDocument.origin] !== undefined;
    const hasAllowOnceGrant = await deps.storage.hasAllowOnceGrant(
      frame.tabId,
      currentDocument.documentId,
    );

    if (hasAlwaysGrant || hasAllowOnceGrant) {
      await transitionToAttaching(frame, currentDocument.documentId, currentDocument.origin, [
        {
          leaseToken: frame.leaseToken,
          attachRequestId: frame.attachRequestId,
        },
      ]);
      return;
    }

    if (frame.reattach === "consent_required_if_missing") {
      deps.sendFrame(createFailure(frame, "consent_required"));
      return;
    }

    const participants: readonly Participant[] = [
      { leaseToken: frame.leaseToken, attachRequestId: frame.attachRequestId },
    ];
    tabStates.set(frame.tabId, {
      phase: "pending_consent",
      documentId: currentDocument.documentId,
      origin: currentDocument.origin,
      participants,
      startedAt: Date.now(),
    });

    const resolution = await deps.consent.requestConsent({
      tabId: frame.tabId,
      origin: currentDocument.origin,
      documentId: currentDocument.documentId,
      getCurrentDocumentId: async (tabId) =>
        (await getMainFrameDocument(tabId))?.documentId ?? null,
    });

    const pendingState = tabStates.get(frame.tabId);
    if (pendingState?.phase !== "pending_consent") return;

    if (resolution === "allow_once" || resolution === "always") {
      await transitionToAttaching(
        frame,
        pendingState.documentId,
        pendingState.origin,
        pendingState.participants,
      );
      return;
    }

    tabStates.delete(frame.tabId);
    for (const participant of pendingState.participants) {
      deps.sendFrame(
        createFailure(
          {
            kind: "attach",
            tabId: frame.tabId,
            leaseToken: participant.leaseToken,
            attachRequestId: participant.attachRequestId,
          },
          resolution === "timeout" ? "timeout" : "user_denied",
        ),
      );
    }
  }

  return {
    handleAttach,
    async handleDetachRequest(frame): Promise<void> {
      const tabId = sessionToTab.get(frame.sessionId);
      if (tabId === undefined) {
        deps.sendFrame({
          kind: "detach_ack",
          sessionId: frame.sessionId,
          tabId: frame.tabId,
          ok: false,
          reason: "not_attached",
        });
        return;
      }
      const outcome = await detachDebugger(tabId);
      sessionToTab.delete(frame.sessionId);
      tabStates.delete(tabId);
      if (outcome.ok) {
        deps.sendFrame({
          kind: "detach_ack",
          sessionId: frame.sessionId,
          tabId,
          ok: true,
        });
      } else {
        const reason = outcome.reason ?? "chrome_error";
        deps.sendFrame({
          kind: "detach_ack",
          sessionId: frame.sessionId,
          tabId,
          ok: false,
          reason,
        });
      }
    },
    async handleAbandonAttach(leaseToken): Promise<readonly number[]> {
      const affectedTabs: number[] = [];
      for (const [tabId, state] of tabStates.entries()) {
        if (state.phase !== "pending_consent" && state.phase !== "attaching") continue;
        if (!state.participants.some((participant) => participant.leaseToken === leaseToken))
          continue;
        affectedTabs.push(tabId);
        const remainingParticipants = state.participants.filter(
          (participant) => participant.leaseToken !== leaseToken,
        );
        for (const participant of state.participants) {
          if (participant.leaseToken !== leaseToken) continue;
          deps.sendFrame(
            createFailure(
              {
                kind: "attach",
                tabId,
                leaseToken: participant.leaseToken,
                attachRequestId: participant.attachRequestId,
              },
              "user_denied",
            ),
          );
        }
        if (remainingParticipants.length > 0) {
          tabStates.set(tabId, { ...state, participants: remainingParticipants });
          continue;
        }
        if (state.phase === "pending_consent") {
          await deps.consent.dismissPrompt(tabId);
          tabStates.delete(tabId);
          continue;
        }
        tabStates.delete(tabId);
      }
      return affectedTabs;
    },
    async handleTabRemoved(tabId): Promise<void> {
      const state = tabStates.get(tabId);
      if (!state) return;
      tabStates.delete(tabId);
      if (state.phase === "attached") {
        sessionToTab.delete(state.sessionId);
        deps.sendFrame(createDetachedFrame(state, "tab_closed"));
        return;
      }
      for (const participant of state.participants) {
        deps.sendFrame(
          createFailure(
            {
              kind: "attach",
              tabId,
              leaseToken: participant.leaseToken,
              attachRequestId: participant.attachRequestId,
            },
            "tab_closed",
          ),
        );
      }
    },
    async handleCommittedNavigation(details): Promise<void> {
      if (details.frameId !== 0) return;
      const state = tabStates.get(details.tabId);
      if (!state) return;
      if (state.phase === "pending_consent" || state.phase === "attaching") {
        if (details.documentId && details.documentId === state.documentId) return;
        tabStates.delete(details.tabId);
        if (state.phase === "pending_consent") await deps.consent.dismissPrompt(details.tabId);
        for (const participant of state.participants) {
          deps.sendFrame(
            createFailure(
              {
                kind: "attach",
                tabId: details.tabId,
                leaseToken: participant.leaseToken,
                attachRequestId: participant.attachRequestId,
              },
              "user_denied",
            ),
          );
        }
        return;
      }

      const origin = details.url ? new URL(details.url).origin : state.origin;
      const allowedByPolicy = await isOriginAllowedByPolicy(deps.storage, origin);
      if (!allowedByPolicy) {
        const outcome = await detachDebugger(details.tabId);
        tabStates.delete(details.tabId);
        sessionToTab.delete(state.sessionId);
        deps.sendFrame(createDetachedFrame(state, "private_origin", outcome.ok));
        return;
      }

      const alwaysGrants = await deps.storage.getAlwaysGrants();
      if (alwaysGrants[origin] === undefined) {
        const outcome = await detachDebugger(details.tabId);
        tabStates.delete(details.tabId);
        sessionToTab.delete(state.sessionId);
        deps.sendFrame(createDetachedFrame(state, "navigated_away", outcome.ok));
        return;
      }

      tabStates.set(details.tabId, {
        ...state,
        documentId: details.documentId ?? state.documentId,
        origin,
      });
    },
    async handleHostDisconnect(): Promise<void> {
      for (const [tabId, state] of [...tabStates.entries()]) {
        if (state.phase === "attached") {
          const outcome = await detachDebugger(tabId);
          tabStates.delete(tabId);
          sessionToTab.delete(state.sessionId);
          deps.sendFrame(createDetachedFrame(state, "extension_reload", outcome.ok));
          continue;
        }
        if (state.phase === "pending_consent") {
          await deps.consent.dismissPrompt(tabId);
          tabStates.delete(tabId);
          for (const participant of state.participants) {
            deps.sendFrame(
              createFailure(
                {
                  kind: "attach",
                  tabId,
                  leaseToken: participant.leaseToken,
                  attachRequestId: participant.attachRequestId,
                },
                "user_denied",
              ),
            );
          }
          continue;
        }

        tabStates.delete(tabId);
        cleanupPending.begin(
          tabId,
          state.attachPromise.then(async (ok) => {
            if (ok) await detachDebugger(tabId);
            return ok;
          }),
        );
        for (const participant of state.participants) {
          deps.sendFrame(
            createFailure(
              {
                kind: "attach",
                tabId,
                leaseToken: participant.leaseToken,
                attachRequestId: participant.attachRequestId,
              },
              "user_denied",
            ),
          );
        }
      }
    },
    getAttachedStateBySessionId(sessionId): AttachedState | null {
      const tabId = sessionToTab.get(sessionId);
      if (tabId === undefined) return null;
      const state = tabStates.get(tabId);
      return state?.phase === "attached" ? state : null;
    },
    getAttachedStates(): readonly AttachedState[] {
      return [...tabStates.values()].filter(
        (state): state is AttachedState => state.phase === "attached",
      );
    },
    getClaimedTabIds(): readonly number[] {
      return [...new Set([...tabStates.keys(), ...cleanupPending.snapshotQueuedTabs()])];
    },
  };
}
