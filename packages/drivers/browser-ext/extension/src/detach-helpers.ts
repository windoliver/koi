import type { NmDetachAck, NmDetached } from "../../src/native-host/nm-frame.js";

export interface AttachedSessionRecord {
  readonly tabId: number;
  readonly sessionId: string;
}

export async function detachDebugger(tabId: number): Promise<{
  readonly ok: boolean;
  readonly reason?: "not_attached" | "chrome_error";
}> {
  try {
    await (
      chrome.debugger.detach as unknown as (target: chrome.debugger.Debuggee) => Promise<void>
    )({
      tabId,
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Debugger is not attached")) {
      return { ok: true, reason: "not_attached" };
    }
    return { ok: false, reason: "chrome_error" };
  }
}

export function createDetachAck(
  session: AttachedSessionRecord,
  outcome: { readonly ok: boolean; readonly reason?: "not_attached" | "chrome_error" },
): NmDetachAck {
  return {
    kind: "detach_ack",
    sessionId: session.sessionId,
    tabId: session.tabId,
    ok: outcome.ok,
    reason: outcome.ok ? undefined : outcome.reason,
  };
}

export function createDetachedFrame(
  session: AttachedSessionRecord,
  reason: NmDetached["reason"],
  priorDetachSuccess?: boolean,
): NmDetached {
  return {
    kind: "detached",
    sessionId: session.sessionId,
    tabId: session.tabId,
    reason,
    priorDetachSuccess,
  };
}
