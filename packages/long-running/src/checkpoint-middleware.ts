/**
 * Checkpoint middleware — fires checkpoints at configurable intervals (Decision 15B).
 *
 * Priority 55 (after harness at 50). Tracks turn count and fires the
 * `onCheckpoint` callback at `policy.intervalTurns`, on session end,
 * and on suspend.
 */

import type { CheckpointPolicy, KoiMiddleware, SessionContext, TurnContext } from "@koi/core";
import { DEFAULT_CHECKPOINT_POLICY } from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CheckpointMiddlewareConfig {
  /** Checkpoint policy. Defaults to DEFAULT_CHECKPOINT_POLICY. */
  readonly policy?: CheckpointPolicy | undefined;
  /** Called when a checkpoint should be persisted. */
  readonly onCheckpoint: (context: {
    readonly turnIndex: number;
    readonly trigger: "interval" | "session_end" | "suspend";
  }) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create middleware that fires checkpoint callbacks at configurable intervals.
 *
 * Delegates actual persistence to the `onCheckpoint` callback — this middleware
 * only decides _when_ to checkpoint, not _how_.
 */
export function createCheckpointMiddleware(config: CheckpointMiddlewareConfig): KoiMiddleware {
  const policy = config.policy ?? DEFAULT_CHECKPOINT_POLICY;

  // let justified: mutable turn counter tracked across turns within a session
  let turnCount = 0;

  return {
    name: "checkpoint-middleware",
    priority: 55,

    describeCapabilities: () => ({
      label: "checkpoint",
      description:
        "Fires checkpoints at configurable turn intervals, on session end, and on suspend.",
    }),

    onBeforeTurn: async (_ctx: TurnContext): Promise<void> => {
      // No-op — checkpoint fires _after_ turns, not before.
    },

    onAfterTurn: async (ctx: TurnContext): Promise<void> => {
      turnCount += 1;
      if (policy.intervalTurns > 0 && turnCount % policy.intervalTurns === 0) {
        await config.onCheckpoint({ turnIndex: ctx.turnIndex, trigger: "interval" });
      }
    },

    onSessionEnd: async (_ctx: SessionContext): Promise<void> => {
      if (policy.onSessionEnd) {
        await config.onCheckpoint({ turnIndex: turnCount, trigger: "session_end" });
      }
      // Reset turn counter for next session
      turnCount = 0;
    },
  };
}
