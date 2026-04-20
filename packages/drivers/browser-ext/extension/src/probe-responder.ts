import type { AttachFsm } from "./attach-fsm.js";
import { detachDebugger } from "./detach-helpers.js";

interface DebuggeeTargetInfo {
  readonly tabId?: number;
  readonly attached?: boolean;
}

export async function respondToAttachStateProbe(fsm: AttachFsm): Promise<readonly number[]> {
  const targets = (await (
    chrome.debugger.getTargets as unknown as () => Promise<readonly DebuggeeTargetInfo[]>
  )()) as readonly DebuggeeTargetInfo[];
  const attachedTargetTabs = new Set(
    targets
      .filter((target) => target.attached && target.tabId !== undefined)
      .map((target) => target.tabId as number),
  );

  // Reconcile stale local claims: if the FSM thinks a tab is attached but
  // Chrome disagrees, tell Chrome to detach defensively (idempotent).
  const claimedTabs = new Set(fsm.getAttachedStates().map((state) => state.tabId));
  for (const tabId of claimedTabs) {
    if (attachedTargetTabs.has(tabId)) continue;
    await detachDebugger(tabId);
  }

  // Return Chrome's authoritative attached set — do NOT filter by local
  // claims. The host uses this to seed quarantine and crash-recover: stale
  // FSM state after a host restart/crash could otherwise hide orphans the
  // host MUST know about.
  return [...attachedTargetTabs];
}
