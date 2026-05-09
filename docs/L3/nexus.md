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
- `config` — resolved feature flags
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
