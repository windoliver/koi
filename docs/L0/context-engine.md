# `ContextEngine` — pluggable context-management slot

> Status: Phase 1 (L0 contract). See issue #1767.

The `ContextEngine` is the ECS subsystem responsible for shaping the message
sequence handed to the model on every turn. It is a **swappable** component:
agents may attach a different engine to trade compaction aggressiveness for
context fidelity, or to experiment with novel strategies (memory-first,
domain-specific injection, full-context passthrough).

## Contract

```ts
interface ContextEngine {
  readonly identity: ContextEngineIdentity;
  readonly prepare: (ctx: TurnContext, messages: readonly InboundMessage[]) =>
    readonly InboundMessage[] | Promise<readonly InboundMessage[]>;
  readonly onAfterTurn?: (ctx: TurnContext) => void | Promise<void>;
  readonly describeOccupancy?: () => ContextOccupancy | Promise<ContextOccupancy>;
}
```

- `identity` — stable name + semver, used for traceability and rollback target
  resolution. Required.
- `prepare` — called once per turn before the model request. Pure function over
  the inbound message list; returns the (possibly compacted/reordered/injected)
  outbound list. Implementations MUST return new arrays — never mutate input.
- `onAfterTurn` — optional post-turn hook for state updates (e.g., backoff
  decay, memory eviction).
- `describeOccupancy` — optional pressure reporter. When present, runtime
  records pressure as a decision input for compaction-policy changes (per AGP
  learnings adaptation, 2026-04-19).

## Occupancy

```ts
interface ContextOccupancy {
  readonly estimatedTokens: number;   // current load
  readonly maxTokens: number;         // engine's effective budget
  readonly pressure: number;          // 0..1, derived
}
```

Invariants:
- `0 <= pressure <= 1`
- `0 <= estimatedTokens`
- `maxTokens > 0`
- `pressure ≈ estimatedTokens / maxTokens` (clamped to 1)

## Identity

```ts
interface ContextEngineIdentity {
  readonly name: string;     // package-style: "@koi/context-manager"
  readonly version: string;  // semver
}
```

Two engines are considered the same iff `name + version` matches.

## SubsystemToken

```ts
const CONTEXT_ENGINE: SubsystemToken<ContextEngine> = token<ContextEngine>("context-engine");
```

Single-instance per agent (singleton component). The slot is **opt-in**: when
no host passes `contextEngineFactory` to `createKoi` and no provider attaches
under `CONTEXT_ENGINE`, the slot is empty and the runtime falls back to its
existing per-turn behavior (no slot-driven preparation, no occupancy report).
Hosts that want the bundled tiered-compaction default explicitly pass
`createContextEngine` from `@koi/context-manager` as the factory. Wiring a
runtime-level default would force `@koi/engine` (L1) to depend on
`@koi/context-manager` (L0u), which the layer rules explicitly forbid for the
kernel runtime — see `CLAUDE.md → Anti-Leak Rules`.

## Swap & rollback (AGP learnings adaptation, 2026-04-19)

Engine swaps are explicit runtime events with traceable cause. The L0 contract
defines the event shape; emission is wired in Phase 5 (depends on the boundary
semantics from #1939).

```ts
interface ContextEngineSwapEvent {
  readonly kind: "context-engine-swap";
  readonly turnId: TurnId;          // boundary at which swap takes effect
  readonly from: ContextEngineIdentity;
  readonly to: ContextEngineIdentity;
  readonly reason: string;          // human-readable cause
  readonly rollbackTarget?: ContextEngineIdentity; // engine to revert to on regression
  readonly timestamp: string;       // ISO-8601
}
```

Rollback semantics:
- A swap MAY carry a `rollbackTarget` — typically the previous engine's identity
- Runtime applies rollback at the next reset boundary (`turn_end` or
  `run_start`, see #1939) when an evaluator marks the swap as regressing
- Rollback emits a second swap event with `from` = current, `to` =
  `rollbackTarget`

## Layer

L0 — interfaces only. No runtime logic. The default engine (Phase 2) lives in
`@koi/context-manager` (L0u). Custom engines are L2 packages or in-tree at the
caller.

## Out of scope (Phase 1)

- Default engine factory (Phase 2)
- L1 slot resolution (Phase 3)
- Passthrough engine (Phase 4)
- Swap event emission + rollback wiring (Phase 5, depends on #1939)
- TUI swap notice (Phase 6, depends on #1940)
- Manifest `context.engine` field (Phase 7)
- Golden replay scenario (Phase 8)
