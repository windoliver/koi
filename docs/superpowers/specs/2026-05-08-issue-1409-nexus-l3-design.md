# `@koi/nexus` — L3 Nexus Wiring Restore (Issue #1409)

**Issue:** [#1409](https://github.com/windoliver/koi/issues/1409) — v2 Phase 3-nexus-5: nexus L3 — wiring meta-package  
**Layer:** L3 meta-package (`packages/meta/nexus`)  
**Status:** Design approved for implementation  
**Scope:** Restore the missing v2 `@koi/nexus` package and clean up stale docs that currently describe it as already present.

## Goal

Add a v2 `@koi/nexus` meta-package that composes the existing Nexus client, store adapters, and backend packages into a single `createNexusStack()` entry point, with no new backend logic. Update the package inventory and L3 docs so the repo accurately reflects the restored package.

## Why This Work Exists

Issue `#1409` calls for the final L3 Nexus wiring layer after the lower-level Nexus packages are in place. In the current v2 workspace:

- the lower-level packages exist
- docs such as `docs/L3/nexus.md` already describe `@koi/nexus`
- the actual package directory under `packages/meta/nexus` does not exist
- the generated package inventory does not list `@koi/nexus`

That leaves the repo in a misleading state: the composition layer is documented, but not implemented.

## Non-Goals

This issue does **not**:

- redesign Nexus transport or health behavior
- add new storage/search/registry/mailbox/workspace logic
- migrate the CLI or runtime to consume `@koi/nexus` internally
- broaden the current Nexus package APIs beyond the composition glue needed for this meta-package

## References

- Current workspace:
  - `docs/L3/nexus.md`
  - `docs/package-coverage-map.md`
  - `packages/meta/rlm-stack`
  - `packages/meta/auto-harness`
- Archive reference:
  - `/Users/sophiawj/private/koi/archive/v1/packages/meta/nexus`
- External reference:
  - `/Users/sophiawj/private/claude-code-source-code`

The archive reference is useful for package shape and namespace intent, but v2 implementation must follow current exported APIs and naming in this workspace.

## Current v2 Constraints

The archived v1 implementation cannot be copied verbatim because several integration points changed:

- scratchpad wiring now exposes `createNexusScratchpad`, not a higher-level provider helper
- workspace wiring now exposes async `createNexusWorkspaceBackend`
- mailbox wiring now exposes async `createNexusMailbox` and expects `NexusTransport`
- current v2 packages generally prefer `NexusTransport` or current backend factories over older client-specific glue
- local Nexus startup in v2 is centered around the current sandbox/transport flow, not the older embed package assumptions in the archive

The restored L3 package therefore needs to be a **thin v2 adapter** over the current package contracts, not a straight port of the archived code.

## Proposed Package Shape

Create a new package at `packages/meta/nexus` with the following focused modules:

- `src/types.ts`
  - exported config and output types for `createNexusStack()`
- `src/namespace.ts`
  - agent/group namespace computation and best-effort provisioning helpers
- `src/global-backends.ts`
  - eager creation of global Nexus backends
- `src/agent-provider.ts`
  - per-agent `ComponentProvider` that assembles agent-scoped components
- `src/nexus-stack.ts`
  - main `createNexusStack()` factory
- `src/index.ts`
  - public API exports
- `src/__tests__/...`
  - focused unit/integration-style tests for composition behavior

This matches the issue’s “wiring only” instruction: small files, one clear purpose per module, no embedded backend logic.

## Public API

The package exposes:

- `createNexusStack(config)`
- package types for stack config, resolved metadata, namespace helpers, and returned bundle
- `computeAgentNamespace(...)`
- `computeGroupNamespace(...)`

The returned bundle should include:

- `backends`
  - eagerly created global backends such as registry, permissions, audit, search, scheduler, and name service when enabled
- `providers`
  - the agent-scoped provider used to attach per-agent components
- `middlewares`
  - any middleware produced by optional wiring such as shared scratchpad integration
- `config`
  - resolved metadata describing what was enabled
- `dispose()`
  - best-effort cleanup for resources created by the stack

The package should stay intentionally small and should not expose a second, parallel abstraction surface.

## Composition Model

### Global Backends

Create global backends eagerly during stack construction. These are shared singletons and should be assembled from the existing v2 packages only. The implementation may allow selective opt-out or override objects per backend, but should not add new semantics beyond wiring.

Expected global surfaces:

- registry
- permissions
- audit
- search
- scheduler
- name service

If additional already-existing Nexus global backends in the archive no longer have live v2 equivalents in this workspace, they are omitted rather than reintroduced through speculative code.

### Agent-Scoped Backends

Create per-agent components inside a `ComponentProvider.attach(agent)` path, based on the current agent identity and optional group identity.

Expected agent-scoped surfaces:

- forge store
- event backend
- session persistence
- memory backend
- snapshot store
- filesystem backend
- mailbox

Each component must be assembled from the current v2 factories, using current contracts rather than archived helper names.

### Group-Scoped Backends

If the attaching agent has a group id, wire a shared Nexus scratchpad instance for that group. If there is no group id, skip scratchpad wiring cleanly.

### Opt-In Backends

Workspace wiring stays opt-in. If enabled, `@koi/nexus` assembles the current async workspace backend and exposes it through the provider attach path. If disabled, no workspace component is attached.

## Namespace Handling

`@koi/nexus` owns the namespace computation and best-effort provisioning helpers so callers do not have to duplicate path conventions.

Rules:

- namespace derivation must be deterministic from agent id and group id
- namespace rules should be centralized in one helper module
- provisioning should be best-effort
- provisioning failures should not invent new recovery behavior beyond logging or typed skipping consistent with current package style

The implementation should prefer current v2 path constants or package-local canonical path helpers where they already exist.

## Error Handling

Error handling should stay conservative and wiring-focused:

- invalid top-level config should fail fast during stack creation
- optional disabled surfaces should resolve to omission, not partial fake implementations
- optional integrations that depend on missing agent context, such as scratchpad without group id, should be skipped explicitly
- async provider wiring failures should surface through normal attach failure paths unless a specific current package already models the condition as a typed skipped component

No new fallback framework or new health state machine should be introduced in this package.

## Documentation Changes

Option `B` includes cleanup of stale documentation so the repo stops claiming `@koi/nexus` already exists when it does not.

Expected docs updates:

- `docs/package-coverage-map.md`
  - include the new `@koi/nexus` package in the meta package inventory
- `docs/L3/nexus.md`
  - align wording with the actual restored v2 package behavior and current package names
- any nearby docs that explicitly refer to `@koi/nexus` as present if the wording now drifts from the restored implementation

This is documentation correction, not a broader docs rewrite.

## Testing Strategy

This restore should follow TDD and prove composition behavior rather than backend internals.

Required coverage:

- stack creation composes expected global pieces
- feature detection reflects enabled and omitted backends
- provider attach wires current v2 agent-scoped components
- group-scoped scratchpad wiring is present only when group id exists
- workspace is attached only when explicitly enabled
- namespace helpers return stable expected paths
- best-effort disposal does not throw on normal cleanup paths

Tests should avoid depending on a real live Nexus process unless a current package pattern in this repo already requires it for the same composition boundary.

## Implementation Boundaries

Implementation should prefer:

- current v2 package exports in `packages/lib`, `packages/security`, `packages/sched`, and `packages/net`
- thin composition adapters inside `packages/meta/nexus`
- small compatibility shims only when needed to bridge archived provider expectations to current v2 APIs

Implementation should avoid:

- copying archived types or helper names that no longer exist in v2
- creating new L2 helpers just for convenience unless the current v2 package boundary truly requires it
- changing runtime/CLI behavior to consume `@koi/nexus` in this issue

## Acceptance Criteria

The issue is complete when:

- `packages/meta/nexus` exists and builds
- `createNexusStack()` composes current v2 Nexus packages through a tested L3 API
- unit tests cover the composition and gating behavior above
- package metadata and exports are correct
- docs and package inventory no longer falsely imply a missing package or outdated behavior

## Risks and Mitigations

### Risk: archived implementation mismatches current v2 APIs

Mitigation:

- treat archive/v1 as a structural reference only
- adapt to current exported factories and async boundaries

### Risk: scope expands into runtime migration

Mitigation:

- keep this issue limited to restoring the package and fixing stale docs
- do not rewire current CLI/runtime consumers in this change

### Risk: provider glue becomes a hidden source of new logic

Mitigation:

- keep provider code focused on assembly, namespace derivation, and attach/dispose orchestration only
- push any true backend behavior questions back to the owning L2 package instead of solving them here
