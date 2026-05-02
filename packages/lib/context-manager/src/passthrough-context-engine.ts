/**
 * Passthrough `ContextEngine` — no compaction, no replacement, no occupancy
 * pressure. Suitable for short sessions or debugging where every prior
 * message must reach the model verbatim.
 *
 * Phase 4 of issue #1767. Companion to `createContextEngine` (default tiered
 * compaction); use this when you want the slot filled but the pipeline
 * neutralized.
 */

import type {
  ContextEngine,
  ContextEngineIdentity,
  ContextOccupancy,
} from "@koi/core/context-engine";
import type { InboundMessage } from "@koi/core/message";
import type { TurnContext } from "@koi/core/middleware";

export const PASSTHROUGH_CONTEXT_ENGINE_IDENTITY: ContextEngineIdentity = {
  name: "@koi/context-manager/passthrough",
  version: "1.0.0",
} as const;

export interface PassthroughContextEngineOptions {
  readonly identity?: ContextEngineIdentity;
}

/**
 * Build a passthrough `ContextEngine`. `prepare` returns its input unchanged;
 * `describeOccupancy` reports zero pressure since no budget is enforced.
 */
export function createPassthroughContextEngine(
  options: PassthroughContextEngineOptions = {},
): ContextEngine {
  const identity = options.identity ?? PASSTHROUGH_CONTEXT_ENGINE_IDENTITY;

  const prepare = async (
    _ctx: TurnContext,
    messages: readonly InboundMessage[],
  ): Promise<readonly InboundMessage[]> => messages;

  const describeOccupancy = async (): Promise<ContextOccupancy> => ({
    estimatedTokens: 0,
    maxTokens: Number.POSITIVE_INFINITY,
    pressure: 0,
  });

  return {
    identity,
    prepare,
    describeOccupancy,
  };
}
