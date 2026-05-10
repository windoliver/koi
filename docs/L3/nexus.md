# @koi/nexus — Nexus Composition Bundle

`@koi/nexus` is the restored L3 meta-package for Issue `#1409`. It does not add new Nexus backend behavior; it composes the live v2 Nexus packages in this repo into one `createNexusStack()` entrypoint and centralizes the agent/group namespace helpers.

---

## What It Does

`createNexusStack()` composes three pieces:

- global backend assembly via `createGlobalBackends(...)`
- per-agent component wiring via `createNexusAgentProvider(...)`
- stable namespace helpers via `computeAgentNamespace(...)` and `computeGroupNamespace(...)`

The package returns a `NexusBundle`:

- `backends` — the enabled global Nexus backends
- `providers` — the per-agent provider array to pass into runtime assembly
- `middlewares` — any middleware the caller chooses to attach alongside the bundle
- `features` — per-surface detection metadata showing whether each Nexus surface is active, disabled, unavailable, or running on fallback wiring
- `config` — resolved feature flags plus whether startup fallback activated
- `health()` — bundle-level health snapshot with transport probe result, feature detection, and dashboard summary
- `dashboard()` — dashboard-friendly health projection derived from `health()`
- `dispose()` — best-effort cleanup for the provider and any caller-supplied disposers

---

## Live Package Set

The restored package is intentionally limited to the Nexus packages that actually exist in the active v2 workspace:

- `@koi/registry-nexus`
- `@koi/permissions-nexus`
- `@koi/audit-sink-nexus`
- `@koi/search-nexus`
- `@koi/scheduler-nexus`
- `@koi/fs-nexus`
- `@koi/ipc-nexus`
- `@koi/scratchpad-nexus`
- `@koi/workspace-nexus`
- `@koi/snapshot-store-nexus`
- `@koi/playbook-store-nexus`
- `@koi/handoff`

Archive-era names such as `@koi/nexus-store`, `@koi/filesystem-nexus`, `@koi/pay-nexus`, and `@koi/name-service-nexus` are not part of the live v2 implementation.

---

## API Shape

```ts
import { createNexusStack } from "@koi/nexus";

const nexus = await createNexusStack({
  transport,
  enableScratchpad: true,
  enableWorkspace: false,
  global: {
    registry: true,
    permissions: true,
    audit: false,
    search: true,
    scheduler: true,
  },
  globalFactories: {
    registry: async () => createRegistrySomehow(),
    permissions: async () => createPermissionsSomehow(),
    audit: async () => createAuditSomehow(),
    search: async () => createSearchSomehow(),
    scheduler: async () => createSchedulerSomehow(),
  },
  agentProvider: {
    createFileSystem: (agentId) => createFileSystemSomehow(agentId),
    createMailbox: (agentId) => createMailboxSomehow(agentId),
    createSnapshotStore: (agentId) => createSnapshotStoreSomehow(agentId),
    createPlaybookStore: (agentId) => createPlaybookStoreSomehow(agentId),
    createHandoffStore: (agentId) => createHandoffStoreSomehow(agentId),
    createScratchpad: (groupId) => createScratchpadSomehow(groupId),
    createWorkspace: (agentId) => createWorkspaceSomehow(agentId),
  },
});
```

The stack factory is deliberately composition-focused: callers provide the concrete backend factories they want to use, while `@koi/nexus` handles flag gating, provider assembly, and the final bundle shape.

---

## Feature Detection

The bundle exposes static surface detection through `bundle.features`.

Each feature reports:

- `enabled` — whether the caller requested the surface
- `available` — whether `@koi/nexus` has usable wiring for that surface in this bundle instance
- `mode`
  - `nexus` — live Nexus wiring is active
  - `fallback` — startup degraded to caller-supplied local wiring
  - `disabled` — intentionally turned off by config
  - `unavailable` — requested, but no safe wiring was available for this instance

This satisfies the issue’s “which backends available” requirement without inventing a separate registry subsystem.

---

## Graceful Degradation

`@koi/nexus` now supports startup-only graceful degradation via optional `fallback` config.

Behavior:

- if `healthCheck()` is provided, `@koi/nexus` uses it
- otherwise, if `transport.health()` exists, `@koi/nexus` probes Nexus directly
- if the startup probe fails and caller-supplied fallback factories exist, the bundle activates those fallback factories for the lifetime of the instance
- requested surfaces that do not have fallback wiring are marked `unavailable` instead of silently continuing on unhealthy Nexus wiring

This mirrors the existing v2 L2 pattern used by packages like `@koi/scratchpad-nexus` and `@koi/workspace-nexus`: fallback is explicit, decided at startup, and does not swap authorities mid-run.

---

## Health And Dashboard

`health()` returns a typed snapshot that combines:

- latest Nexus transport probe result
- whether startup fallback is active
- current feature detection metadata
- a `dashboard` projection with an overall status, summary, and per-surface rows

Dashboard status rules:

- `ok` — probe healthy and no degraded/unavailable surfaces are active
- `degraded` — fallback active, probe returns `missing-paths`, or requested surfaces are unavailable
- `unhealthy` — probe failed and no local fallback was activated

This gives dashboard or host callers a single read surface for Nexus health without making `@koi/nexus` responsible for long-running supervision.

---

## Namespaces

The package exports stable path helpers:

```ts
computeAgentNamespace("agent-123");
// {
//   filesystem: "agents/agent-123/filesystem",
//   mailbox: "agents/agent-123/mailbox",
//   snapshotStore: "agents/agent-123/snapshots",
//   playbooks: "agents/agent-123/playbooks",
//   handoffs: "agents/agent-123/handoffs",
// }

computeGroupNamespace("group-7");
// { scratchpad: "groups/group-7/scratchpad" }
```

These helpers keep agent/group path conventions in one place instead of repeating them across callers.

---

## Current Scope

This package is restored and tested, but it is not yet the mechanism the CLI uses for host-side Nexus resolution. The current CLI still resolves endpoints through `resolveNexusForHost(...)` and wires Nexus-related packages directly where needed.

That boundary is intentional for Issue `#1409`: restore the L3 composition package first, then migrate consumers separately if we choose to.
