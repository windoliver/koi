/**
 * Bounded concurrency FIFO queue for brick re-verification.
 *
 * All non-sandbox bricks are accepted. No tier-based priority (Issue #703).
 * Dedup: skips bricks already in-flight or pending.
 * Bounded: max N concurrent re-verifications.
 */

import type { BrickArtifact, BrickId } from "@koi/core";
import type { ReverificationConfig } from "./reverification.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ReverificationQueue {
  /** Enqueue a brick for re-verification. Returns false if already in-flight or at capacity. */
  readonly enqueue: (brick: BrickArtifact) => boolean;
  /** Number of currently in-flight re-verifications. */
  readonly activeCount: () => number;
  /** Number of bricks waiting in the queue. */
  readonly pendingCount: () => number;
  /** Dispose: clear all pending items. */
  readonly dispose: () => void;
}

export type ReverificationHandler = (brick: BrickArtifact) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReverificationQueue(
  config: ReverificationConfig,
  handler: ReverificationHandler,
): ReverificationQueue {
  // Mutable state — encapsulated in closure, never leaked
  // Justification: let required for concurrency tracking
  let pending: readonly BrickArtifact[] = [];
  let inFlight: ReadonlySet<BrickId> = new Set<BrickId>();
  let disposed = false;

  function drain(): void {
    if (disposed) {
      return;
    }
    while (inFlight.size < config.maxConcurrency && pending.length > 0) {
      const next = dequeueNext();
      if (next === undefined) {
        break;
      }
      inFlight = new Set([...inFlight, next.id]);
      // Fire-and-forget with completion callback
      handler(next).then(
        () => {
          inFlight = new Set([...inFlight].filter((id) => id !== next.id));
          drain();
        },
        () => {
          inFlight = new Set([...inFlight].filter((id) => id !== next.id));
          drain();
        },
      );
    }
  }

  function dequeueNext(): BrickArtifact | undefined {
    if (pending.length === 0) return undefined;
    const [first, ...rest] = pending;
    pending = rest;
    return first;
  }

  return {
    enqueue(brick: BrickArtifact): boolean {
      if (disposed) {
        return false;
      }
      // Dedup: skip if already in-flight
      if (inFlight.has(brick.id)) {
        return false;
      }
      // Check if already in pending queue
      if (pending.some((b) => b.id === brick.id)) {
        return false;
      }
      // Sandbox bricks are never re-verified
      if (brick.trustTier === "sandbox") {
        return false;
      }

      pending = [...pending, brick];
      drain();
      return true;
    },

    activeCount(): number {
      return inFlight.size;
    },

    pendingCount(): number {
      return pending.length;
    },

    dispose(): void {
      disposed = true;
      pending = [];
    },
  };
}
