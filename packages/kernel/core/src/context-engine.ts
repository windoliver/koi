/**
 * Context-engine slot — pluggable per-turn context-management pipeline.
 *
 * L0 contract for issue #1767. Defines the `ContextEngine` interface,
 * `CONTEXT_ENGINE` SubsystemToken, occupancy/identity types, and the
 * swap-event shape used by Phase 5 runtime emission. No runtime logic.
 */

import type { SubsystemToken, TurnId } from "./ecs.js";
import { token } from "./ecs.js";
import type { InboundMessage } from "./message.js";
import type { TurnContext } from "./middleware.js";

/**
 * Stable identity for a context engine — name + semver. Used for traceability,
 * swap-event from/to fields, and rollback-target resolution.
 */
export interface ContextEngineIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * Snapshot of an engine's current context budget pressure. Used as a decision
 * input by compaction-policy changes (AGP learnings adaptation, 2026-04-19).
 *
 * Invariants: `0 <= pressure <= 1`, `0 <= estimatedTokens`, `maxTokens > 0`.
 * `pressure` is the engine's own derivation — typically
 * `min(estimatedTokens / maxTokens, 1)` — but engines MAY apply hysteresis.
 */
export interface ContextOccupancy {
  readonly estimatedTokens: number;
  readonly maxTokens: number;
  readonly pressure: number;
}

/**
 * Pluggable context-management pipeline. Attached to an agent via
 * `CONTEXT_ENGINE` subsystem token.
 *
 * `prepare` runs once per turn before the model request; the returned message
 * list replaces the turn's inbound list for the model call. Implementations
 * MUST return a new array — never mutate the input.
 */
export interface ContextEngine {
  readonly identity: ContextEngineIdentity;
  readonly prepare: (
    ctx: TurnContext,
    messages: readonly InboundMessage[],
  ) => readonly InboundMessage[] | Promise<readonly InboundMessage[]>;
  readonly onAfterTurn?: (ctx: TurnContext) => void | Promise<void>;
  readonly describeOccupancy?: () => ContextOccupancy | Promise<ContextOccupancy>;
}

/**
 * Structured event emitted when the runtime swaps the active `ContextEngine`.
 * Phase 1 defines the shape; Phase 5 wires emission at the boundary defined
 * by #1939 (turn_end / run_start).
 */
export interface ContextEngineSwapEvent {
  readonly kind: "context-engine-swap";
  readonly turnId: TurnId;
  readonly from: ContextEngineIdentity;
  readonly to: ContextEngineIdentity;
  readonly reason: string;
  readonly rollbackTarget?: ContextEngineIdentity;
  /**
   * Per-turn pin contract: turns already in flight when `swap()` runs keep
   * using the pre-swap engine until they reach their reset boundary —
   * mid-turn engine substitution would split `prepare()` ↔ `onAfterTurn()`
   * across two engines and corrupt stateful bookkeeping.
   *
   * This list maps each in-flight turnId to the identity of the engine it
   * is actually serving on. Across multiple sequential swaps, different
   * pinned turns may resolve to different engines (e.g. `t1` started on A,
   * swap to B, `t2` started on B, swap to C — `t1` is still on A even
   * though `from` is now B). Carrying the per-turn engine identity lets
   * audit logs, TUI notices, and evaluators attribute each turn correctly
   * instead of assuming everything in `pinnedTurns` ran on `from`.
   *
   * Empty array (or omitted) means no in-flight pins existed at swap time
   * — every subsequent turn uses `to`.
   */
  readonly pinnedTurns?: readonly {
    readonly turnId: TurnId;
    readonly engineIdentity: ContextEngineIdentity;
  }[];
  readonly timestamp: string;
}

/**
 * Singleton SubsystemToken for the active context engine.
 *
 * The slot is opt-in: hosts pass `contextEngineFactory` to `createKoi` (or
 * attach a `ContextEngine` under this token via a `ComponentProvider`). When
 * neither is present, the slot is empty and the runtime falls back to its
 * existing per-turn behavior. The kernel does NOT install a default engine
 * implicitly — that would force `@koi/engine` (L1) to depend on a specific
 * L2/L0u package, violating the layer rules. Hosts that want the bundled
 * tiered-compaction default pass `createContextEngine` from
 * `@koi/context-manager` explicitly.
 */
export const CONTEXT_ENGINE: SubsystemToken<ContextEngine> = token<ContextEngine>("context-engine");
