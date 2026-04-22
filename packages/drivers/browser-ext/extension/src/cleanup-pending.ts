import type { NmAttach } from "../../src/native-host/nm-frame.js";

export interface CleanupPendingManager {
  readonly begin: (tabId: number, attachPromise: Promise<boolean>) => void;
  readonly enqueue: (frame: NmAttach) => boolean;
  readonly has: (tabId: number) => boolean;
  readonly snapshotQueuedTabs: () => readonly number[];
}

interface QueuedAttach {
  readonly frame: NmAttach;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
  /**
   * Becomes true when the 60s fail-out fires. release() must skip terminal
   * entries so a timed-out attach can never be replayed after its failure
   * ack was already sent — that would produce contradictory attach_ack
   * traffic for the same request.
   */
  terminal: boolean;
}

interface CleanupEntry {
  readonly queued: QueuedAttach[];
  readonly advisoryHandle: ReturnType<typeof setTimeout>;
}

export function createCleanupPendingManager(deps: {
  readonly runAttach: (frame: NmAttach) => Promise<void>;
  readonly failAttach: (frame: NmAttach, reason: "tab_closed") => void;
  readonly advisoryDetach: (tabId: number) => Promise<void>;
}): CleanupPendingManager {
  const entries = new Map<number, CleanupEntry>();

  async function release(tabId: number): Promise<void> {
    const entry = entries.get(tabId);
    if (!entry) return;
    entries.delete(tabId);
    clearTimeout(entry.advisoryHandle);
    for (const queued of entry.queued) {
      clearTimeout(queued.timeoutHandle);
      if (queued.terminal) continue; // failure already dispatched — do not replay
      await deps.runAttach(queued.frame);
    }
  }

  return {
    begin(tabId, attachPromise): void {
      const advisoryHandle = setTimeout(() => {
        void deps.advisoryDetach(tabId);
      }, 10_000);

      entries.set(tabId, { queued: [], advisoryHandle });
      void attachPromise.finally(async () => {
        await release(tabId);
      });
    },
    enqueue(frame): boolean {
      const entry = entries.get(frame.tabId);
      if (!entry) return false;
      const queued: QueuedAttach = {
        frame,
        terminal: false,
        timeoutHandle: setTimeout(() => {
          // Mark terminal BEFORE failAttach so a concurrent release() iterating
          // the queue sees the flag and skips replay.
          queued.terminal = true;
          deps.failAttach(frame, "tab_closed");
        }, 60_000),
      };
      entry.queued.push(queued);
      return true;
    },
    has: (tabId) => entries.has(tabId),
    snapshotQueuedTabs: () => [...entries.keys()],
  };
}
