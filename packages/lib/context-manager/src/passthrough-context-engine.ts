/**
 * Passthrough `ContextEngine` — no compaction, no replacement, no occupancy
 * pressure. Suitable for short sessions or debugging where every prior
 * message must reach the model verbatim.
 *
 * Phase 4 of issue #1767. Companion to `createContextEngine` (default tiered
 * compaction); use this when you want the slot filled but the pipeline
 * neutralized.
 */

import type { ContextEngine, ContextEngineIdentity } from "@koi/core/context-engine";
import type { InboundMessage } from "@koi/core/message";
import type { TurnContext } from "@koi/core/middleware";

// `version` mirrors the parent artifact (@koi/context-manager@1.0.0) so
// swap notices and manifest pins describe the actual shipped passthrough.
export const PASSTHROUGH_CONTEXT_ENGINE_IDENTITY: ContextEngineIdentity = {
  name: "@koi/context-manager/passthrough",
  version: "1.0.0",
} as const;

export interface PassthroughContextEngineOptions {
  readonly identity?: ContextEngineIdentity;
}

/**
 * Build a passthrough `ContextEngine`. `prepare` returns its input unchanged.
 *
 * `describeOccupancy` is intentionally omitted: this engine performs no budget
 * accounting, so reporting `pressure: 0` would mislead any policy that uses
 * occupancy to detect overflow. Callers must inspect the absence of the
 * reporter and apply their own pressure model when running passthrough.
 */
export function createPassthroughContextEngine(
  options: PassthroughContextEngineOptions = {},
): ContextEngine {
  const identity = options.identity ?? PASSTHROUGH_CONTEXT_ENGINE_IDENTITY;

  // Per the ContextEngine contract: never alias the input array. Callers may
  // mutate the returned list in place (or freeze it), so the engine MUST
  // hand back an independent copy even when no transformation is applied.
  const prepare = async (
    _ctx: TurnContext,
    messages: readonly InboundMessage[],
  ): Promise<readonly InboundMessage[]> => messages.slice();

  return {
    identity,
    prepare,
  };
}
