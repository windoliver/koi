/**
 * Checkpoint middleware — wires the engine's afterTurn hook to the
 * harness's soft-checkpoint trigger.
 */

import type { KoiMiddleware, TurnContext } from "@koi/core";

export interface CheckpointMiddlewareInput {
  readonly intervalTurns: number;
  readonly onTurnStart: (ctx: TurnContext) => void;
  readonly onTurnEnd: (ctx: TurnContext) => Promise<void>;
}

export function createCheckpointMiddleware(input: CheckpointMiddlewareInput): KoiMiddleware {
  return {
    name: "long-running:checkpoint",
    onBeforeTurn: async (ctx: TurnContext): Promise<void> => {
      input.onTurnStart(ctx);
    },
    onAfterTurn: async (ctx: TurnContext): Promise<void> => {
      await input.onTurnEnd(ctx);
    },
    describeCapabilities: () => undefined,
  };
}
