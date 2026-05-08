# Design: Issue #1373 Remaining Nexus Variants

**Date:** 2026-05-07
**Issue:** [#1373](https://github.com/windoliver/koi/issues/1373)
**Status:** Supersedes the slice-1-only implementation focus by defining the remaining v2 work for this branch

---

## Overview

Issue `#1373` remains open because v2 currently includes `@koi/ipc-nexus` only. The remaining scope for this branch is:

- `@koi/scratchpad-nexus`
- `@koi/workspace-nexus`

Both packages must implement existing v2 contracts, remain optional, and support explicit fallback to local behavior when Nexus is unavailable or fails after startup.

The design follows the same v2 strategy already used by `@koi/ipc-nexus`: thin adapters over `@koi/nexus-client`, with Nexus RPC details isolated in package-local client modules and no direct v1 porting of the archived packages.

---

## Goals

- Add `@koi/scratchpad-nexus` as a v2 `ScratchpadComponent`
- Add `@koi/workspace-nexus` as a v2 `WorkspaceBackend`
- Preserve contract parity with the current local implementations
- Make fallback behavior explicit and testable
- Keep Nexus-specific transport and method naming isolated from the public API

---

## Non-Goals

- Rebuilding every archived v1 helper, tool, or provider surface
- Introducing automatic recovery from fallback mode back into Nexus mode
- Changing `@koi/core` contracts to fit Nexus behavior
- Making Nexus-backed variants the default runtime path
- Refactoring `packages/lib/workspace` or `packages/lib/scratchpad-local` beyond what is needed for contract alignment

---

## Existing Context

### Current v2 packages

- [`packages/lib/ipc-nexus`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/lib/ipc-nexus)
- [`packages/lib/scratchpad-local`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/lib/scratchpad-local)
- [`packages/lib/workspace`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/lib/workspace)
- [`packages/lib/nexus-client`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/lib/nexus-client)

### Archive references

- `/Users/sophiawj/private/koi/archive/v1/packages/ipc/scratchpad-nexus`
- `/Users/sophiawj/private/koi/archive/v1/packages/ipc/workspace-nexus`

### Contract sources

- [`packages/kernel/core/src/scratchpad.ts`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/kernel/core/src/scratchpad.ts)
- [`packages/kernel/core/src/workspace.ts`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/kernel/core/src/workspace.ts)

---

## Package Layout

This branch adds two new packages under `packages/lib`:

```text
packages/lib/scratchpad-nexus/
packages/lib/workspace-nexus/
```

This matches the current v2 package layout and keeps the new implementations aligned with `ipc-nexus`, `scratchpad-local`, and `workspace`.

---

## Recommended Approach

### Approach A: thin v2 adapters over `@koi/nexus-client` (recommended)

Build both packages around the current v2 contracts and use the archived implementations only as behavioral reference.

Pros:

- aligns with the existing `@koi/ipc-nexus` package
- keeps public APIs small and contract-oriented
- isolates Nexus RPC naming and payload mapping in one place per package
- makes fallback logic explicit instead of implicit

Cons:

- requires fresh mapping code instead of a direct copy
- some archive behavior must be translated rather than reused verbatim

### Approach B: direct v1 port

Copy the archived packages into `packages/lib` and patch them until they compile against v2.

Pros:

- quick initial scaffolding
- lower design effort at the beginning

Cons:

- drags forward outdated package structure
- likely duplicates transport logic that now belongs in `@koi/nexus-client`
- makes it harder to match v2 naming and testing patterns cleanly

### Approach C: local-first wrappers with Nexus mirroring

Treat the local implementations as authoritative and sync Nexus opportunistically.

Pros:

- simple fallback story
- high reuse of local implementation code

Cons:

- changes semantics: distributed state appears local even when remote persistence fails
- poor fit for workspace metadata as a source-of-truth concern
- blurs whether callers are observing shared Nexus state or local-only state

### Recommendation

Use **Approach A** for both remaining packages.

---

## Cross-Cutting Rules

### 1. Explicit fallback only

Fallback must be injected by the caller.

- `scratchpad-nexus` accepts an optional fallback `ScratchpadComponent`
- `workspace-nexus` accepts an optional fallback `WorkspaceBackend`

If no fallback is provided, Nexus failures should surface through the normal contract result or behavior instead of silently creating local state.

### 2. Creation-time health gate

If `transport.health()` is available:

- use Nexus mode when health succeeds
- use fallback immediately when health fails and fallback exists
- still create the Nexus-backed implementation when health fails and no fallback exists, so the failure surface stays explicit

### 3. Startup-only fallback (no runtime degrade)

The fallback is a STARTUP-ONLY escape hatch. Once an instance has been
returned by `createNexusScratchpad()` / `createNexusWorkspaceBackend()`,
the chosen authority is fixed for the lifetime of the instance —
runtime RPC failures NEVER swap authorities.

Adversarial review during implementation confirmed this is the safe
choice: the two backends do not share state, so a one-way runtime
degrade after the instance has already served Nexus state would fork
the source of truth (scratchpad: callers see/overwrite an empty local
store while Nexus still holds the real entries) or orphan live Nexus
survivors (workspace: provider creates duplicates after restart
because fallback inventory is incomplete). Runtime failures propagate
as contract-shaped errors so callers can retry instead of silently
operating against the wrong authority.

### 4. Contract parity over internal parity

The target is parity with the v2 local variants and `@koi/core` contracts:

- same method names
- same return shapes
- same ordering guarantees that callers depend on
- same category of validation and external errors where practical

Internal helpers, polling state, and RPC payload shapes do not need to match the archive implementation line-for-line.

---

## `@koi/scratchpad-nexus`

### Purpose

Provide a Nexus-backed `ScratchpadComponent` that stores group-scoped scratchpad state in Nexus while preserving the v2 scratchpad contract and allowing optional fallback to a local scratchpad.

### Public API

The public entry point should be a factory similar in shape to `ipc-nexus`:

```ts
export interface NexusScratchpadConfig {
  readonly groupId: AgentGroupId;
  readonly authorId: AgentId;
  readonly transport: NexusTransport;
  readonly fallback?: ScratchpadComponent | undefined;
  readonly methodPrefix?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly pageSize?: number | undefined;
}

export function createNexusScratchpad(
  config: NexusScratchpadConfig,
): Promise<ScratchpadComponent>;
```

### Behavior

- `write()` sends a Nexus mutation and returns the mapped `ScratchpadWriteResult`
- `read()` reads the latest entry version from Nexus
- `list()` lists summaries from Nexus with the same filter semantics the local implementation exposes
- `delete()` removes an entry from Nexus
- `flush()` only flushes local transient state used by the Nexus adapter; it does not invent extra persistence semantics
- `onChange()` uses polling in the first pass rather than SSE, tracking seen generations locally
- `close()` tears down polling/subscriber state and delegates to fallback if the instance has already degraded

### Source of truth

Nexus is the source of truth for shared scratchpad state. Local memory is limited to:

- polling timers
- subscriber registrations
- seen-generation bookkeeping
- degraded/fallback mode state

The package must not keep an authoritative local cache that can diverge from Nexus indefinitely.

### Error handling

- validation errors should remain local and deterministic where possible
- Nexus transport failures surface to callers as contract-shaped errors; they do NOT trigger a runtime swap to the fallback (see "Startup-only fallback" above)

### First-pass simplifications

- polling only, no push transport
- no runtime degrade — fallback is wired only at construction time
- no attempt to reproduce every archive helper if the behavior can be expressed more simply in v2

---

## `@koi/workspace-nexus`

### Purpose

Provide a Nexus-backed `WorkspaceBackend` that stores workspace records in Nexus and materializes local workspace state as needed, while preserving compatibility with the existing `createWorkspaceProvider()` flow.

### Public API

The factory should return a normal `WorkspaceBackend` so the existing workspace provider can use it without any provider-level changes:

```ts
export interface NexusWorkspaceBackendConfig {
  readonly transport: NexusTransport;
  readonly fallback?: WorkspaceBackend | undefined;
  readonly methodPrefix?: string | undefined;
  readonly basePath?: string | undefined;
}

export function createNexusWorkspaceBackend(
  config: NexusWorkspaceBackendConfig,
): Promise<WorkspaceBackend>;
```

### Behavior

- `create()` writes a workspace record to Nexus and returns a `WorkspaceInfo`
- `dispose()` removes the workspace record and performs any required local cleanup for the Nexus-backed materialization strategy
- `isHealthy()` checks whether the workspace still exists in the selected backend
- optional methods such as `exists()` or `findByAgentId()` may be implemented if they are needed for compatibility with `packages/lib/workspace/src/provider.ts`

### Provider compatibility

The existing provider in [`packages/lib/workspace/src/provider.ts`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/lib/workspace/src/provider.ts) already expects a `WorkspaceBackend`.

That means `workspace-nexus` should integrate by implementing the backend contract directly rather than by creating a new provider shape. If provider compatibility requires additional optional backend methods used by crash-survivor or cleanup flows, the Nexus backend should implement them instead of changing the provider.

### Source of truth

Nexus is the source of truth for workspace records. Local state is materialized execution state only.

This means:

- workspace identity and ownership live in Nexus
- any local directory or marker file is an execution detail, not the authoritative record
- fallback mode uses the injected local backend as its own source of truth after degradation

### Error handling

- creation-time health failure with fallback should select fallback immediately
- runtime Nexus failures should degrade to fallback when possible
- when no fallback exists, backend operations should fail explicitly rather than fabricate a local workspace

### First-pass simplifications

- one-way degradation only
- no attempt to unify the local git-worktree backend and the Nexus backend internally
- no extra archive-era utilities unless they are required to satisfy the current backend contract

---

## Testing Strategy

Both packages should follow the same v2 expectations already used elsewhere in `packages/lib`.

### Shared expectations

- API-surface tests for stable exports
- focused unit tests around client mapping and degradation logic
- contract-style tests against the v2 local variants where behavior must match

### `scratchpad-nexus` tests

- writes persist through Nexus and can be read back
- list filters behave like the local scratchpad contract
- delete removes entries from subsequent reads/lists
- change polling delivers unseen updates once
- creation-time health failure selects fallback when present
- runtime transport failure degrades permanently to fallback

### `workspace-nexus` tests

- create/dispose round-trip through the backend contract
- health checks reflect Nexus-backed workspace state
- provider compatibility works with `createWorkspaceProvider()`
- creation-time health failure selects fallback when present
- runtime backend failure degrades permanently to fallback
- cross-instance visibility works where the backend exposes survivor/discovery behavior required by the provider

---

## Delivery Order

Implement the remaining scope in this order:

1. `@koi/scratchpad-nexus`
2. `@koi/workspace-nexus`

Rationale:

- scratchpad has the smaller contract surface and a cleaner mapping to the archive behavior
- it validates the fallback and client-isolation pattern before workspace lifecycle work
- workspace depends more heavily on provider compatibility and optional backend behaviors, so it benefits from lessons learned in the first package

---

## Risks And Mitigations

### Risk: workspace provider expects more backend behavior than the core interface suggests

Mitigation:

- inspect `packages/lib/workspace/src/provider.ts` first
- implement the optional backend methods it actually uses
- do not change provider behavior unless a real incompatibility appears

### Risk: scratchpad change delivery semantics drift from local behavior

Mitigation:

- define polling-based semantics narrowly for the first pass
- test delivery against unseen generations and duplicate suppression
- prefer stable, deterministic behavior over ambitious realtime delivery

### Risk: fallback mode hides data-loss boundaries

Mitigation:

- degrade once and stay degraded
- keep the fallback choice explicit in config
- do not silently sync local fallback state back into Nexus in this branch

---

## Success Criteria

This branch is complete for issue `#1373` when:

- `packages/lib/scratchpad-nexus` exists and passes its focused tests
- `packages/lib/workspace-nexus` exists and passes its focused tests
- both packages implement current v2 contracts rather than archive-only shapes
- explicit fallback behavior is covered by tests
- the repo can reasonably close `#1373` because all three intended Nexus variants now exist in v2
