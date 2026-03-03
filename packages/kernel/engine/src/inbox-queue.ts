/**
 * In-memory inbox queue — FIFO queue per mode with per-mode capacity limits.
 *
 * Implements the InboxComponent interface from @koi/core.
 * The engine drains this at turn boundaries.
 */

import type { InboxComponent, InboxItem, InboxPolicy } from "@koi/core";
import { DEFAULT_INBOX_POLICY } from "@koi/core";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateInboxQueueConfig {
  readonly policy?: InboxPolicy | undefined;
}

/**
 * Create an in-memory inbox queue with per-mode capacity limits (Decision 14B).
 *
 * - `collect` items: batch for next turn context (cap: 20 default)
 * - `followup` items: queue for future turns (cap: 50 default)
 * - `steer` items: inject immediately via adapter (cap: 1 default)
 */
export function createInboxQueue(config?: CreateInboxQueueConfig): InboxComponent {
  const policy = config?.policy ?? DEFAULT_INBOX_POLICY;

  // Per-mode queues
  const collectQueue: InboxItem[] = [];
  const followupQueue: InboxItem[] = [];
  const steerQueue: InboxItem[] = [];

  /** Get the queue and cap for a given mode. */
  function queueForMode(mode: InboxItem["mode"]): {
    readonly queue: InboxItem[];
    readonly cap: number;
  } {
    switch (mode) {
      case "collect":
        return { queue: collectQueue, cap: policy.collectCap };
      case "followup":
        return { queue: followupQueue, cap: policy.followupCap };
      case "steer":
        return { queue: steerQueue, cap: policy.steerCap };
    }
  }

  const push = (item: InboxItem): boolean => {
    const { queue, cap } = queueForMode(item.mode);
    if (queue.length >= cap) return false;
    queue.push(item);
    return true;
  };

  const drain = (): readonly InboxItem[] => {
    const items = [...collectQueue, ...followupQueue, ...steerQueue];
    collectQueue.length = 0;
    followupQueue.length = 0;
    steerQueue.length = 0;
    return items;
  };

  const peek = (): readonly InboxItem[] => {
    return [...collectQueue, ...followupQueue, ...steerQueue];
  };

  const depth = (): number => {
    return collectQueue.length + followupQueue.length + steerQueue.length;
  };

  return { push, drain, peek, depth };
}
