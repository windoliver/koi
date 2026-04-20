import type { DriverFrame } from "./driver-frame.js";
import type { InFlightMap } from "./in-flight-map.js";
import type { NmFrame } from "./nm-frame.js";
import type { OwnershipMap } from "./ownership-map.js";

type AttachDriverFrame = Extract<DriverFrame, { kind: "attach" }>;
type AttachAckNmFrame = Extract<NmFrame, { kind: "attach_ack" }>;

export interface AttachCoordinator {
  readonly handleAttachFromDriver: (clientId: string, frame: AttachDriverFrame) => void;
  readonly handleAttachAckFromExtension: (frame: AttachAckNmFrame) => void;
  readonly handleDriverDisconnect: (clientId: string) => void;
}

/**
 * §8.5 attach-flow coordinator.
 *
 * Rules implemented:
 *   1. attach-frame receive: check committed ownership; check other-client pending; else register inFlight + forward
 *   2. attach_ack success: promote inFlight → committed ownership; clear other inFlight entries for same tab
 *   3. attach_ack failure: reject; clear inFlight
 *   4. driver disconnect: mark all inFlight as abandoned; host-initiated detach of committed tabs
 */
export function createAttachCoordinator(deps: {
  readonly ownership: OwnershipMap;
  readonly inFlight: InFlightMap;
  readonly sendNm: (frame: NmFrame) => void;
  readonly sendDriver: (clientId: string, frame: DriverFrame) => void;
  readonly initiateHostDetach: (tabId: number) => void;
  readonly now: () => number;
}): AttachCoordinator {
  const { ownership, inFlight, sendNm, sendDriver, initiateHostDetach, now } = deps;

  function replyAlreadyAttached(
    clientId: string,
    frame: AttachDriverFrame,
    currentOwner: { clientId: string; since: string } | undefined,
  ): void {
    sendDriver(clientId, {
      kind: "attach_ack",
      ok: false,
      tabId: frame.tabId,
      leaseToken: frame.leaseToken,
      attachRequestId: frame.attachRequestId,
      reason: "already_attached",
      ...(currentOwner ? { currentOwner } : {}),
    });
  }

  return {
    handleAttachFromDriver(clientId, frame): void {
      const owner = ownership.get(frame.tabId);
      if (owner) {
        if (owner.phase === "detaching_failed") {
          replyAlreadyAttached(clientId, frame, undefined);
          return;
        }
        if (owner.clientId === clientId) {
          // Same-client retry on already-committed session: return the
          // existing sessionId as a success ack. Benign retries (reconnect
          // races, double-submits) must be idempotent, not false-failed with
          // `already_attached` while the tab is in fact attached to this
          // very caller.
          sendDriver(clientId, {
            kind: "attach_ack",
            ok: true,
            tabId: frame.tabId,
            leaseToken: frame.leaseToken,
            attachRequestId: frame.attachRequestId,
            sessionId: owner.sessionId,
          });
          return;
        }
        replyAlreadyAttached(clientId, frame, {
          clientId: owner.clientId,
          since: new Date(owner.since).toISOString(),
        });
        return;
      }

      const pending = inFlight.entriesForTab(frame.tabId);
      const otherClientPending = pending.some((e) => e.clientId !== clientId);
      if (otherClientPending) {
        replyAlreadyAttached(clientId, frame, undefined);
        return;
      }

      inFlight.add({
        tabId: frame.tabId,
        clientId,
        attachRequestId: frame.attachRequestId,
        leaseToken: frame.leaseToken,
        receivedAt: now(),
        abandoned: false,
      });
      sendNm(frame);
    },

    handleAttachAckFromExtension(frame): void {
      const entry = inFlight.findByTabAndRequest(frame.tabId, frame.attachRequestId);
      if (!entry) return;
      inFlight.delete(entry.clientId, entry.attachRequestId);

      if (entry.abandoned) {
        if (frame.ok) {
          sendNm({ kind: "abandon_attach", leaseToken: frame.leaseToken });
        }
        return;
      }

      if (frame.ok) {
        ownership.set(frame.tabId, {
          phase: "committed",
          clientId: entry.clientId,
          sessionId: frame.sessionId,
          committingRequestId: entry.attachRequestId,
          since: now(),
        });
        sendDriver(entry.clientId, frame);
        for (const other of inFlight.entriesForTab(frame.tabId)) {
          if (other.attachRequestId === entry.attachRequestId) continue;
          inFlight.delete(other.clientId, other.attachRequestId);
          // Same-client / same-lease retries are idempotent: fan the
          // successful sessionId out to them instead of converting to
          // `already_attached`. Reconnect / double-submit callers get the
          // session they asked for.
          if (other.clientId === entry.clientId || other.leaseToken === entry.leaseToken) {
            sendDriver(other.clientId, {
              kind: "attach_ack",
              ok: true,
              tabId: frame.tabId,
              leaseToken: other.leaseToken,
              attachRequestId: other.attachRequestId,
              sessionId: frame.sessionId,
            });
          } else {
            sendDriver(other.clientId, {
              kind: "attach_ack",
              ok: false,
              tabId: frame.tabId,
              leaseToken: other.leaseToken,
              attachRequestId: other.attachRequestId,
              reason: "already_attached",
              currentOwner: {
                clientId: entry.clientId,
                since: new Date(now()).toISOString(),
              },
            });
          }
        }
        return;
      }

      sendDriver(entry.clientId, frame);
    },

    handleDriverDisconnect(clientId): void {
      const abandoned = inFlight.markAbandonedByClient(clientId);
      const seenLeases = new Set<string>();
      for (const entry of abandoned) {
        if (seenLeases.has(entry.leaseToken)) continue;
        seenLeases.add(entry.leaseToken);
        sendNm({ kind: "abandon_attach", leaseToken: entry.leaseToken });
      }
      for (const [tabId, owner] of ownership.entries()) {
        if (owner.clientId === clientId && owner.phase === "committed") {
          initiateHostDetach(tabId);
        }
      }
    },
  };
}
