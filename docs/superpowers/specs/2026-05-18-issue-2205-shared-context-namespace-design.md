# Issue 2205 Shared Context Namespace Design

## Goal

Add the first multi-agent shared context namespace surface for agents and sub-agents working in parallel. The initial slice defines the L0 contract, provides an in-memory namespace implementation, supports namespace-level read-only/read-write access, and emits change notifications without creating direct agent-to-agent communication.

## Architecture

`@koi/core` owns only the contract types. The runtime implementation lives in `@koi/fs-scoped`, reusing its existing `createScopedFileSystem()` wrapper for read-only/read-write enforcement over `FileSystemBackend`.

The namespace is a world-service style component: parents and children can share the same `ContextNamespace` instance, but agents interact with the mounted filesystem backend through namespace resolution rather than by calling each other. This preserves the architecture rule that agents communicate through world services, not entity-to-entity links.

## Contract

The L0 contract adds:

- `ContextNamespaceAccessMode = "ro" | "rw"`
- `ContextNamespaceMount` with `path`, `backend`, `mode`, and optional `metadata`
- `ContextNamespaceChangeEvent` for `mounted`, `unmounted`, and `resolved` observations
- `ContextNamespace` with `mount`, `unmount`, `resolve`, `list`, and optional `watch`

`resolve(path)` returns the mounted backend for the longest matching namespace prefix. The resolved backend is scoped to the mounted backend root and access mode. Paths under `/shared/` resolve to the stable shared context namespace when mounted there.

## Implementation

`@koi/fs-scoped` adds `createContextNamespace()` because it already owns filesystem scoping and is an L0u package. The implementation:

- normalizes namespace paths to absolute POSIX-style paths
- rejects non-absolute mount paths and root (`/`) mounts
- replaces an existing mount when the same path is mounted again
- resolves by longest prefix so `/shared/project` wins over `/shared`
- wraps each mounted backend with `createScopedFileSystem(backend, { root, mode })`
- emits watcher events for mount, unmount, and resolve

The initial implementation uses in-memory mounts and synchronous watchers. A future Nexus-backed implementation can use the same L0 contract and forward events to `EventBackend` or Nexus record streams.

## Spawn Composition

The first implementation does not add direct spawn behavior. Spawn and handoff flows can pass the same `ContextNamespace` instance through existing provider/component composition. A later L1 wiring step can add a narrow `SpawnChildOptions` inheritance field if needed, but the contract and namespace behavior are useful and testable without coupling `spawnChildAgent()` to a concrete storage package.

## Testing

Tests cover:

- L0 export inventory and API surface for the new contract
- mount/list/unmount behavior
- longest-prefix resolution
- read-only vs read-write enforcement through the resolved backend
- watcher events for namespace changes and resolution
- stable `/shared/` visibility through a shared namespace instance

## Out of Scope

- Per-file grants
- Nexus/ReBAC RPC integration
- Direct engine spawn option wiring
- Durable event replay for namespace changes
