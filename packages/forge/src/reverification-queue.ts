/**
 * Bounded concurrency queue for brick re-verification.
 *
 * Priority: promoted bricks first, then verified.
 * Dedup: skips bricks already in-flight.
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
  let promotedPending: readonly BrickArtifact[] = [];
  let verifiedPending: readonly BrickArtifact[] = [];
  let inFlight: ReadonlySet<BrickId> = new Set<BrickId>();
  let disposed = false;

  function drain(): void {
    if (disposed) {
      return;
    }
    while (inFlight.size < config.maxConcurrency && totalPending() > 0) {
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

  function totalPending(): number {
    return promotedPending.length + verifiedPending.length;
  }

  function dequeueNext(): BrickArtifact | undefined {
    if (config.promotedFirst && promotedPending.length > 0) {
      const [first, ...rest] = promotedPending;
      promotedPending = rest;
      return first;
    }
    if (verifiedPending.length > 0) {
      const [first, ...rest] = verifiedPending;
      verifiedPending = rest;
      return first;
    }
    if (promotedPending.length > 0) {
      const [first, ...rest] = promotedPending;
      promotedPending = rest;
      return first;
    }
    return undefined;
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
      // Check if already in a pending queue
      if (
        promotedPending.some((b) => b.id === brick.id) ||
        verifiedPending.some((b) => b.id === brick.id)
      ) {
        return false;
      }

      if (brick.trustTier === "promoted") {
        promotedPending = [...promotedPending, brick];
      } else if (brick.trustTier === "verified") {
        verifiedPending = [...verifiedPending, brick];
      } else {
        // sandbox bricks are never re-verified
        return false;
      }

      drain();
      return true;
    },

    activeCount(): number {
      return inFlight.size;
    },

    pendingCount(): number {
      return totalPending();
    },

    dispose(): void {
      disposed = true;
      promotedPending = [];
      verifiedPending = [];
    },
  };
}
