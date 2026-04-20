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

  const claimedTabs = new Set(fsm.getAttachedStates().map((state) => state.tabId));
  for (const tabId of claimedTabs) {
    if (attachedTargetTabs.has(tabId)) continue;
    await detachDebugger(tabId);
  }

  return [...attachedTargetTabs].filter((tabId) => !claimedTabs.has(tabId));
}
