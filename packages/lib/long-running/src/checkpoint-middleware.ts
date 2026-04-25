/**
 * Checkpoint middleware — wires the engine's afterTurn hook to the
 * harness's soft-checkpoint trigger.
 */

import type { KoiMiddleware, TurnContext } from "@koi/core";

export interface CheckpointMiddlewareInput {
  readonly intervalTurns: number;
  readonly onTurnStart: () => void;
  readonly onTurnEnd: () => Promise<void>;
}

export function createCheckpointMiddleware(input: CheckpointMiddlewareInput): KoiMiddleware {
  return {
    name: "long-running:checkpoint",
    onBeforeTurn: async (_ctx: TurnContext): Promise<void> => {
      input.onTurnStart();
    },
    onAfterTurn: async (_ctx: TurnContext): Promise<void> => {
      await input.onTurnEnd();
    },
    describeCapabilities: () => undefined,
  };
}
