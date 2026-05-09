# Design: System Signal Adapters for Issue #1298

## Summary

Issue `#1298` needs three `SystemSignalSource` adapters that make governance thresholds, Grove frontier streams, and Nexus events observable to the proactive composition layer.

In the current v2 repo, the L0 `SystemSignal` contract already exists, but the issue text is partially stale:

- `SystemSignal` does not currently include a `kind: "frontier"` variant.
- `.claude/plans/v2-rewrite.md` is not present in this checkout.
- active Grove and Nexus source trees are not present at the locations named in the issue body.

This design lands the adapters in `@koi/proactive` now, with internal boundaries that allow later extraction into domain-specific packages. It implements the full adapter surfaces for governance, Grove, and Nexus, but only emits signals that the current v2 `SystemSignal` contract can represent honestly.

## Goals

- Implement `SystemSignalSource` adapters in `@koi/proactive` for governance, Grove, and Nexus.
- Keep the public surface narrow and planner-facing.
- Align all emitted events with the current `SystemSignal` contract in `@koi/core`.
- Support fail-open runtime behavior so adapter faults do not crash the proactive pipeline.
- Structure the code so transport and normalization logic can move later with minimal API churn.

## Non-Goals

- Changing the L0 `SystemSignal` contract.
- Inventing a new `frontier` signal variant.
- Executing composition plans.
- Reconstructing missing Grove or Nexus server packages inside this issue.
- Adding speculative event mappings that are not grounded in the current repo contract.

## Current Repo Context

- [packages/kernel/core/src/system-signal.ts](/Users/sophiawj/.codex/worktrees/c478/koi/packages/kernel/core/src/system-signal.ts:1) defines the active v2 `SystemSignal` and `SystemSignalSource` contracts.
- [packages/kernel/core/src/governance.ts](/Users/sophiawj/.codex/worktrees/c478/koi/packages/kernel/core/src/governance.ts:1) defines `GovernanceController`, `GovernanceSnapshot`, and the well-known governance sensor names.
- [packages/lib/proactive/src/index.ts](/Users/sophiawj/.codex/worktrees/c478/koi/packages/lib/proactive/src/index.ts:1) is the correct current export surface for proactive planner-side integration code.
- [docs/superpowers/specs/2026-05-06-composition-planner-design.md](/Users/sophiawj/.codex/worktrees/c478/koi/docs/superpowers/specs/2026-05-06-composition-planner-design.md:33) already records that the referenced rewrite plan file is missing and that current work should anchor on the live repo.

## Package Placement

The adapters should live in `@koi/proactive` for this first pass.

Recommended structure:

- `packages/lib/proactive/src/system-signal-sources/governance.ts`
- `packages/lib/proactive/src/system-signal-sources/grove.ts`
- `packages/lib/proactive/src/system-signal-sources/nexus.ts`
- `packages/lib/proactive/src/system-signal-sources/shared.ts`

Public exports should come from `packages/lib/proactive/src/index.ts`:

- `createGovernanceSignalSource`
- `createGroveSignalSource`
- `createNexusSignalSource`
- any public config or threshold types needed by callers

This keeps the current planner-facing package cohesive while allowing later extraction of transport-specific code into governance or federation packages without changing the factory names.

## Public APIs

### Governance

```ts
export interface GovernanceThreshold {
  readonly sensor: string;
  readonly limit: number;
  readonly direction: "above" | "below";
  readonly cooldownMs?: number | undefined;
}

export interface GovernanceSignalSourceConfig {
  readonly pollIntervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export function createGovernanceSignalSource(
  controller: GovernanceController,
  thresholds: readonly GovernanceThreshold[],
  config?: GovernanceSignalSourceConfig,
): SystemSignalSource
```

### Grove

```ts
export interface GroveSignalSourceConfig {
  readonly groveUrl: string;
  readonly metrics?: readonly string[] | undefined;
  readonly minImprovement?: number | undefined;
  readonly eventSourceFactory?: ((url: string) => GroveEventSourceLike) | undefined;
}

export function createGroveSignalSource(
  config: GroveSignalSourceConfig,
): SystemSignalSource
```

The Grove adapter surface is part of the deliverable even though live emission support will be conservative until the upstream v2 event vocabulary is clearer.

### Nexus

```ts
export interface NexusSignalSourceConfig {
  readonly nexusUrl?: string | undefined;
  readonly channels?: readonly string[] | undefined;
  readonly pathFilters?: readonly string[] | undefined;
  readonly subscribe?: NexusSubscribeFn | undefined;
}

export function createNexusSignalSource(
  config: NexusSignalSourceConfig,
): SystemSignalSource
```

The Nexus adapter accepts a subscription callback or equivalent injectable bridge so tests and future transports do not depend on a missing concrete Nexus package in this repo.

## Architecture

Each adapter factory returns a `SystemSignalSource` with a `watch(handler, options?)` method.

Shared helper responsibilities:

- asynchronous delivery to the consumer handler
- `sampleRateMs` throttling on a per-subscription basis
- `onError` and `onDisconnect` lifecycle callbacks
- idempotent unsubscribe behavior
- small utility helpers for pattern filtering and safe callback invocation

Each adapter owns its domain-specific normalization logic:

- governance: polling and threshold edge detection
- Grove: SSE transport and event normalization
- Nexus: event subscription and mapping to VFS or lifecycle signals

## Event Mapping

### Governance Mapping

Governance thresholds map directly to the current L0 governance signal:

```ts
{
  kind: "governance",
  sensor,
  value,
  limit,
  direction,
  emittedAt,
}
```

Behavior:

- the adapter polls `controller.snapshot()`
- each configured threshold tracks whether it is currently in alert state
- a signal emits only when a threshold crosses from non-alerting to alerting
- repeated samples while still alerting do not emit
- cooldown applies per configured threshold
- replay, when requested, performs an immediate sample and emits currently-alerting thresholds

### Grove Mapping

The issue text expects a frontier signal, but the live v2 contract does not have one. This design does not invent a replacement union member.

First-pass Grove behavior:

- implement the subscription surface, filtering hooks, and parsing pipeline
- emit only when an incoming Grove event can be represented by the existing `SystemSignal` contract without distortion
- ignore event classes that require a non-existent `frontier` variant or another speculative shape
- route malformed frames to `options.onError` and continue listening

The likely first shippable Grove emission path is metric-shift-style events if they can be normalized into an already-supported `anomaly` shape. If no such truthful mapping exists in the live repo, the adapter remains transport-ready but emission-conservative.

### Nexus Mapping

The Nexus adapter emits only current contract shapes that are clearly grounded:

- file writes and deletes map to `kind: "vfs"`
- renames map to the rename variant of `kind: "vfs"`
- agent state transitions map to `kind: "agent_lifecycle"`

Task dispatch and completion events are out of scope unless the real upstream source can be mapped directly to the current `schedule` terminal-event contract without guessing.

## Failure Handling

All adapters are fail-open.

Rules:

- `watch()` must not throw after the subscription has been created
- handler invocation must be asynchronous
- transport, polling, or parse failures call `options.onError` when provided
- recoverable failures do not terminate the subscription
- terminal disconnects call `options.onDisconnect`
- unsubscribe must be safe to call multiple times

## Testing Strategy

### Governance Tests

- emits on threshold crossing above
- emits on threshold crossing below
- does not emit repeatedly while still in alert state
- cooldown suppresses rapid repeated crossings
- replay emits currently-alerting thresholds
- unsubscribe stops polling and future emissions
- snapshot failure reports to `onError` and keeps the source alive

### Grove Tests

- constructs the expected subscription URL or transport target
- filters by metric when configured
- applies `minImprovement` correctly
- malformed frames call `onError`
- unsupported event classes are ignored rather than coerced
- only representable events emit `SystemSignal`
- unsubscribe closes the transport cleanly

### Nexus Tests

- normalizes write, delete, and rename events to `vfs`
- applies path filters correctly
- normalizes lifecycle transitions to `agent_lifecycle`
- ignores unrelated channels
- subscription errors route through `onError`
- unsubscribe detaches the underlying listener

### Shared Behavior Tests

- handler delivery is asynchronous
- `sampleRateMs` throttles delivery per subscription
- `onDisconnect` fires at most once per terminal close
- repeated unsubscribe calls are no-ops

## Implementation Notes

- `@koi/proactive` should expose only the factories and public config types.
- Transport-specific implementation details should stay internal.
- Injected transport/subscription factories should be preferred over hard-coding a browser or server runtime dependency.
- The Grove and Nexus adapters should be useful in tests and future integration code even when local live emission support is intentionally narrow.

## Risks and Mitigations

- Risk: the issue text describes event shapes that no longer match the contract.
  Mitigation: anchor all emitted signals to the live `SystemSignal` union and document the conservative behavior explicitly.

- Risk: Grove and Nexus upstream APIs are not available in this checkout.
  Mitigation: design the adapters around injectable transport bridges and normalization logic, not direct package imports from missing trees.

- Risk: consumers may assume Grove emits frontier signals immediately.
  Mitigation: keep the public API stable but document that unsupported event classes are ignored until the core signal vocabulary grows.

## Recommendation

Ship the full adapter surfaces in `@koi/proactive` now, with complete governance behavior and conservative Grove/Nexus emission logic. This lands useful infrastructure for `#1298` without drifting the core contract or fabricating source integrations that are not actually present in the live v2 repo.
