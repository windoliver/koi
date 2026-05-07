# Design: Issue #1373 Nexus-Backed IPC, Workspace, and Scratchpad Variants

**Date:** 2026-05-06
**Issue:** [#1373](https://github.com/windoliver/koi/issues/1373)
**Approach:** B - thin v2 adapters over `@koi/nexus-client`, delivered incrementally

---

## Overview

Issue `#1373` adds three optional Nexus-backed variants that implement existing v2 contracts:

- `@koi/ipc-nexus` for `MailboxComponent`
- `@koi/workspace-nexus` for `WorkspaceBackend`
- `@koi/scratchpad-nexus` for `ScratchpadComponent`

The v1 archive already contains working versions of all three packages, but v2 now has:

- a shared transport package at [`packages/lib/nexus-client`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/lib/nexus-client)
- different package locations and naming conventions under `packages/lib`
- stronger contract emphasis in `@koi/core`
- an explicit requirement that Nexus variants remain optional and support fallback to local behavior when Nexus is unavailable

The design here keeps the v1 behavioral intent while avoiding a line-for-line port.

---

## Project Context

### Existing v2 contracts

- [`packages/kernel/core/src/mailbox.ts`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/kernel/core/src/mailbox.ts)
- [`packages/kernel/core/src/workspace.ts`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/kernel/core/src/workspace.ts)
- [`packages/kernel/core/src/scratchpad.ts`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/kernel/core/src/scratchpad.ts)

### Existing local references

- [`packages/lib/ipc-local`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/lib/ipc-local)
- [`packages/lib/workspace`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/lib/workspace)
- [`packages/lib/scratchpad-local`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/lib/scratchpad-local)

### Archive reference implementations

- [`archive/v1/packages/ipc/ipc-nexus`](/Users/sophiawj/private/koi/archive/v1/packages/ipc/ipc-nexus)
- [`archive/v1/packages/ipc/workspace-nexus`](/Users/sophiawj/private/koi/archive/v1/packages/ipc/workspace-nexus)
- [`archive/v1/packages/ipc/scratchpad-nexus`](/Users/sophiawj/private/koi/archive/v1/packages/ipc/scratchpad-nexus)

### Supporting v2 transport

- [`packages/lib/nexus-client`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/packages/lib/nexus-client)

---

## Approaches Considered

### Approach A: direct v1 port

Copy each archive package into `packages/lib`, fix imports, and patch tests until green.

Pros:
- fastest path to something runnable
- preserves proven behavior from the archive

Cons:
- drags forward bespoke v1 client wrappers that duplicate `@koi/nexus-client`
- likely carries v1 assumptions about package layout and runtime wiring
- makes fallback behavior harder to express cleanly in v2

### Approach B: thin adapters over `@koi/nexus-client`

Rebuild each package around the current v2 contracts, using v1 for behavior and test shape only.

Pros:
- matches the direction v2 is already taking
- avoids duplicating transport logic
- keeps the new packages focused on contract mapping, fallback, and state semantics

Cons:
- more design work up front
- slightly slower than a direct port

### Approach C: wrap local implementations with sync layers

Keep local implementations authoritative and add Nexus write-through or mirror sync around them.

Pros:
- strong fallback story
- maximum reuse of local behavior

Cons:
- unnatural fit for mailbox delivery
- risks hiding network failures behind local state in ways that blur contract semantics
- likely different per subsystem anyway

### Recommendation

Use **Approach B** and deliver the work in three slices:

1. `@koi/ipc-nexus`
2. `@koi/scratchpad-nexus`
3. `@koi/workspace-nexus`

This keeps the first implementation small, validates the transport boundary early, and lets the more stateful packages learn from the first slice.

---

## Non-Goals

- restoring every v1 tool, provider, or UI integration in the first pass
- introducing new Nexus server capabilities
- changing the L0 contracts in `@koi/core`
- making Nexus variants the default runtime path

---

## Package Layout

Three new packages will be added under `packages/lib`:

```text
packages/lib/ipc-nexus/
packages/lib/scratchpad-nexus/
packages/lib/workspace-nexus/
```

This matches the current v2 package layout used by `ipc-local`, `scratchpad-local`, and `workspace`.

---

## Cross-Cutting Design Rules

### 1. Transport ownership

Each package uses `NexusTransport` from `@koi/nexus-client` as the low-level RPC surface.

Packages may optionally expose an HTTP convenience factory that builds a transport internally, but the core factories should accept a `NexusTransport` so tests can inject fakes.

### 2. Local fallback is explicit

The issue requires fallback to local when Nexus is unavailable. To keep this deterministic and testable, each package accepts an explicit local fallback implementation rather than silently inventing one.

Examples:

- `ipc-nexus` accepts a fallback `MailboxComponent`
- `scratchpad-nexus` accepts a fallback `ScratchpadComponent`
- `workspace-nexus` accepts a fallback `WorkspaceBackend`

If no fallback is provided, Nexus failures surface normally through the package contract.

### 3. Health checks are creation-time gates, not hot-path network calls

When a package is configured with a fallback, it should decide whether to start in Nexus mode or fallback mode using `transport.health()` where available. It should not probe health before every operation.

After creation:

- normal calls go to the selected backend
- transient operation failures may trigger a one-way degradation into fallback mode
- the first pass does not require automatic recovery back into Nexus mode

This keeps behavior predictable and easy to test.

### 4. Contract parity beats feature parity

The requirement is “same contracts as local variants,” not “same internal architecture as v1.” The new packages should preserve:

- method names
- return types
- failure surface
- ordering semantics that callers depend on

But internal helpers, module names, and buffering details may change.

---

## Slice 1: `@koi/ipc-nexus`

### Goal

Provide a `MailboxComponent` implementation backed by Nexus JSON-RPC, with optional fallback to a local mailbox.

### Public API

```typescript
export interface NexusMailboxConfig {
  readonly agentId: AgentId;
  readonly transport: NexusTransport;
  readonly fallback?: MailboxComponent | undefined;
  readonly inboxMethodPrefix?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly pageSize?: number | undefined;
}

export function createNexusMailbox(
  config: NexusMailboxConfig,
): MailboxComponent | Promise<MailboxComponent>;
```

The first pass should prefer polling over SSE. v1 used SSE plus polling fallback, but v2 already has a generic transport and the issue scope does not require real-time push specifically. Polling is enough to satisfy persisted delivery and cross-node visibility while keeping the initial implementation smaller.

### Behavior

- `send(message)` maps `AgentMessageInput` to Nexus RPC and returns a fully populated `AgentMessage`
- `list(filter)` returns inbox messages for the configured agent, newest first
- `onMessage(handler)` starts polling for new messages and dispatches unseen entries
- `drain()` returns buffered inbox messages already observed by the component and clears the local buffer

### Nexus mode vs fallback mode

- If `transport.health()` succeeds, create a Nexus-backed mailbox
- If health fails and `fallback` is present, use the fallback mailbox instead
- If health fails and no fallback exists, create the Nexus mailbox anyway and let normal call failures surface

### RPC shape

The exact Nexus methods should be isolated behind a small client module in this package. The client becomes the only place that knows method names and payload mapping.

Candidate methods:

- `ipc.send`
- `ipc.list`
- `ipc.ack` if the server supports it

If the current server surface differs, that difference should remain inside the client module.

### File layout

```text
packages/lib/ipc-nexus/src/
  index.ts
  types.ts
  client.ts
  map-message.ts
  seen-set.ts
  mailbox.ts
  mailbox.test.ts
  __tests__/api-surface.test.ts
```

---

## Slice 2: `@koi/scratchpad-nexus`

### Goal

Provide a `ScratchpadComponent` backed by Nexus storage with CAS semantics and optional local fallback.

### Public API

```typescript
export interface NexusScratchpadConfig {
  readonly groupId: AgentGroupId;
  readonly authorId: AgentId;
  readonly transport: NexusTransport;
  readonly fallback?: ScratchpadComponent | undefined;
  readonly basePath?: string | undefined;
}

export function createNexusScratchpad(
  config: NexusScratchpadConfig,
): ScratchpadComponent | Promise<ScratchpadComponent>;
```

### Behavior

- preserve `ScratchpadComponent` method signatures from `@koi/core`
- preserve per-path CAS semantics from the local contract
- prefer direct read/write/delete/list calls first
- defer write buffering and generation-cache optimization until after basic contract parity exists

This is an intentional simplification from v1. The first v2 version should start with correctness and contract parity, then add buffering or cache layers only if profiling or test coverage shows a real need.

### Fallback rule

Fallback is selected at creation-time health check or on first unrecoverable Nexus operation error when `fallback` exists.

---

## Slice 3: `@koi/workspace-nexus`

### Goal

Provide a `WorkspaceBackend` backed by Nexus metadata persistence with optional local fallback backend.

### Public API

```typescript
export interface NexusWorkspaceBackendConfig {
  readonly transport: NexusTransport;
  readonly fallback?: WorkspaceBackend | undefined;
  readonly basePath?: string | undefined;
  readonly localBaseDir?: string | undefined;
}

export function createNexusWorkspaceBackend(
  config: NexusWorkspaceBackendConfig,
): WorkspaceBackend | Promise<WorkspaceBackend>;
```

### Behavior

- create local workspace directories on the current host
- persist metadata to Nexus for cross-node discovery
- keep `WorkspaceInfo` and lifecycle semantics consistent with the current `WorkspaceBackend` contract
- preserve Nexus-first artifact ordering only if the selected server methods and failure semantics still justify it in v2

This package is the least urgent slice because it is less central to agent-to-agent coordination than IPC and scratchpad.

---

## Testing Strategy

### Shared strategy

- use `bun:test`
- inject fake `NexusTransport` objects directly
- avoid network servers in unit tests
- verify contract parity against the current local packages where practical

### `ipc-nexus`

Required tests:

- sends a message through the transport and reconstructs `AgentMessage`
- lists inbox messages using `MessageFilter.limit`
- polls and emits unseen messages via `onMessage`
- `drain()` returns buffered seen messages and clears them
- falls back to local mailbox when health check fails and fallback exists
- surfaces Nexus errors when no fallback exists

### `scratchpad-nexus`

Required tests:

- write/read/list/delete round-trip
- create-only and CAS update conflict semantics
- fallback to local scratchpad when health check fails
- same method return shapes as local scratchpad

### `workspace-nexus`

Required tests:

- create persists metadata and returns `WorkspaceInfo`
- dispose removes persisted metadata
- `isHealthy()` reflects Nexus metadata availability plus local directory existence
- fallback to local backend when health check fails

---

## Documentation Impact

The current docs and package coverage map mention packages that do not exist yet. As each slice lands, the package docs must be updated to match the implemented scope rather than the broader archive-era feature set.

Specifically:

- `docs/L2/ipc-nexus.md`
- `docs/L2/scratchpad-nexus.md`
- `docs/L2/workspace-nexus.md`
- `docs/package-coverage-map.md`

---

## Rollout Plan

### Phase 1

Implement `@koi/ipc-nexus` only.

### Phase 2

Implement `@koi/scratchpad-nexus` after `ipc-nexus` proves the RPC mapping and fallback shape.

### Phase 3

Implement `@koi/workspace-nexus` last.

This keeps each phase reviewable and ensures we do not block the whole issue on the most stateful subsystem.

---

## Open Questions Resolved For This Spec

- **Should we port SSE from v1 immediately?** No. Start with polling in `ipc-nexus`.
- **Should fallback be automatic and invisible?** No. It is explicit in config and one-way after degradation.
- **Should scratchpad start with buffer/cache layers?** No. Start with direct correctness-first calls.
- **Should workspace land before IPC?** No. `ipc-nexus` is the first slice.

---

## Recommendation

Start implementation with `@koi/ipc-nexus` in this branch. It is the smallest slice, validates the `NexusTransport` integration pattern, and gives the next two packages a cleaner template for fallback and contract parity.
