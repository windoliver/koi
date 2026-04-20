import type { NmFrame } from "./nm-frame.js";
import type { OwnershipMap } from "./ownership-map.js";

type DetachAckNmFrame = Extract<NmFrame, { kind: "detach_ack" }>;
type DetachedNmFrame = Extract<NmFrame, { kind: "detached" }>;

export interface DetachCoordinator {
  readonly initiateHostDetach: (tabId: number) => void;
  readonly handleDetachAck: (frame: DetachAckNmFrame) => void;
  readonly handleDetachedFromExtension: (frame: DetachedNmFrame) => void;
  readonly clearAll: () => void;
}

export function createDetachCoordinator(deps: {
  readonly ownership: OwnershipMap;
  readonly sendNm: (frame: NmFrame) => void;
  readonly notifyDriver: (
    clientId: string,
    frame:
      | Extract<NmFrame, { kind: "detach_ack" }>
      | {
          readonly kind: "session_ended";
          readonly sessionId: string;
          readonly tabId: number;
          readonly reason: string;
        },
  ) => void;
  readonly timeoutMs?: number;
  readonly now: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}): DetachCoordinator {
  const { ownership, sendNm, notifyDriver, now } = deps;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const setT = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const pending = new Map<string, { tabId: number; clientId: string; timer: unknown }>();

  function markDetachingFailed(tabId: number, reason: string): void {
    const cur = ownership.get(tabId);
    if (!cur) return;
    ownership.set(tabId, {
      phase: "detaching_failed",
      clientId: cur.clientId,
      sessionId: cur.sessionId,
      reason,
      since: now(),
    });
  }

  return {
    initiateHostDetach(tabId): void {
      const cur = ownership.get(tabId);
      if (!cur || cur.phase !== "committed") return;
      sendNm({ kind: "detach", sessionId: cur.sessionId, tabId });
      const timer = setT(() => {
        if (pending.delete(cur.sessionId)) {
          markDetachingFailed(tabId, "timeout");
        }
      }, timeoutMs);
      pending.set(cur.sessionId, { tabId, clientId: cur.clientId, timer });
    },

    handleDetachAck(frame): void {
      const entry = pending.get(frame.sessionId);
      if (!entry) return;
      pending.delete(frame.sessionId);
      clearT(entry.timer);
      const owner = ownership.get(entry.tabId);
      if (!owner) return;
      if (frame.ok || frame.reason === "not_attached") {
        ownership.delete(entry.tabId);
        notifyDriver(owner.clientId, {
          kind: "session_ended",
          sessionId: frame.sessionId,
          tabId: entry.tabId,
          reason: frame.reason ?? "unknown",
        });
        return;
      }
      markDetachingFailed(entry.tabId, frame.reason ?? "chrome_error");
    },

    handleDetachedFromExtension(frame): void {
      const owner = ownership.get(frame.tabId);
      if (!owner) return;
      if (owner.sessionId !== frame.sessionId) return;
      ownership.delete(frame.tabId);
      notifyDriver(owner.clientId, {
        kind: "session_ended",
        sessionId: frame.sessionId,
        tabId: frame.tabId,
        reason: frame.reason,
      });
    },

    clearAll(): void {
      for (const { timer } of pending.values()) clearT(timer);
      pending.clear();
    },
  };
}
