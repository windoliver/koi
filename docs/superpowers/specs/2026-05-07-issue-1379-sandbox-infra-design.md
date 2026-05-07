# Sandbox IPC + Cloud Base Design (issue #1379)

**Date:** 2026-05-07
**Issue:** [#1379](https://github.com/windoliver/koi/issues/1379) — v2 Phase 3-sandbox-4
**Branch:** `codex/issue-1379-sandbox-4`

## Goal

Restore the missing execution-infrastructure pieces of the sandbox stack in a way that fits the current v2 tree:

- `@koi/sandbox-cloud-base` as an **L0u** package in `packages/lib/sandbox-cloud-base`
- `@koi/sandbox-ipc` as an **L2** package in `packages/sandbox/sandbox-ipc`

The v2 deliverable is intentionally narrower than the archived v1 umbrella. We are not reviving a large meta-stack or a second executor abstraction. Instead:

- `@koi/sandbox-executor` remains the code-execution contract for running arbitrary code.
- `@koi/sandbox-ipc` provides a reusable structured bridge for host-to-worker execution and an adapter that exposes that bridge through the existing `SandboxExecutor` contract.
- `@koi/sandbox-cloud-base` provides the shared low-level utilities that multiple hosted sandbox backends and bridge users can consume without depending on a peer L2 package.

## Why this is still needed

The current tree already contains:

- `@koi/sandbox-executor`
- `@koi/sandbox-router`
- `@koi/sandbox-os`
- cloud adapters such as `@koi/sandbox-daytona` and `@koi/sandbox-e2b`

But two real gaps remain:

1. There is no reusable structured IPC bridge package for sandboxed workers.
2. There is no shared L0u utility package for bridge caching, line framing, profile-validation reuse, and cloud-backend helper logic.

Those gaps show up directly in the live repo:

- current docs still reference `@koi/sandbox-cloud-base` and `@koi/sandbox-ipc`
- cloud adapters duplicate fail-closed profile-validation patterns
- `@koi/sandbox-executor` docs still describe `@koi/sandbox-ipc` as a consumer

## Non-goals

This issue does **not** reintroduce the full v1 package surface.

Out of scope for this branch:

- a new L3 sandbox meta-package
- replacing `@koi/sandbox-executor`
- routing cloud adapters through `@koi/sandbox-ipc`
- reviving v1's broad "sandbox stack" API wholesale
- runtime wiring beyond what is necessary to keep the new packages buildable and documented
- provider-specific cloud mounts or persistence features that have no v2 caller yet

## Chosen package split

### `@koi/sandbox-cloud-base` (`packages/lib/sandbox-cloud-base`) — L0u

Role: pure helpers and shared runtime primitives that may be imported by L1 and L2 packages.

Layer rule:

- imports from `@koi/core` and peer L0u only
- must not import `@koi/sandbox-executor`, `@koi/sandbox-ipc`, or any other L2 package

Initial public surface:

1. **Cached bridge lifecycle**
   - `createCachedBridge(config)`
   - wraps a generic acquire/release executor/bridge factory
   - supports lazy warmup, TTL disposal, hard max-lifetime, and explicit dispose
   - v2 version is generic over a reusable bridge/executor interface instead of hard-coding an adapter-to-shell bridge

2. **Profile validation helpers**
   - `detectUnsupportedProfileFields(profile)`
   - `formatUnsupportedProfileError(adapterName, unsupported)`
   - shared by hosted sandbox adapters such as E2B and Daytona so fail-closed policy errors stay consistent

3. **Bounded line/output helpers**
   - `createLineReader()`
   - `createOutputAccumulator()`
   - reusable for NDJSON-over-stdio, provider log streams, and bridge protocols

4. **Lifecycle guard helpers**
   - destroy/dispose guard utilities for idempotent teardown and post-destroy method rejection

5. **Shell escaping helpers**
   - explicitly deferred from the initial v2 surface
   - add only in a follow-up if a concrete v2 caller requires command interpolation helpers

Rejected alternative:

- putting these helpers inside `@koi/sandbox-ipc`

Reason: that would make cloud-adapter consumers depend on an L2 package just to reuse pure helper logic, which violates the layering intent and makes later extraction noisy.

### `@koi/sandbox-ipc` (`packages/sandbox/sandbox-ipc`) — L2

Role: structured host↔worker execution bridge.

Layer rule:

- imports `@koi/core` plus selected L0u packages only
- specifically allowed to depend on `@koi/sandbox-cloud-base`
- must not import peer L2 packages such as `@koi/sandbox-os` directly; platform-specific command building stays injected

Initial public surface:

1. **Bridge core**
   - `createSandboxBridge(options)`
   - per-execution worker spawn
   - typed worker protocol
   - bridge timeout, result-size cap, disposal semantics

2. **Reusable higher-level bridge API**
   - protocol message types
   - bridge config types
   - process abstraction for testability
   - error mapping utilities

3. **Executor adapter**
   - `bridgeToExecutor(config)`
   - exposes a `SandboxExecutor` backed by the IPC bridge
   - this is the compatibility surface for current `@koi/sandbox-executor` consumers

4. **Worker source/runtime**
   - a Bun child that receives code + input, executes it, and replies over structured IPC
   - result validation and explicit error framing

## Architecture

### High-level data flow

```text
host caller
  -> SandboxExecutor.execute(...)
  -> @koi/sandbox-ipc bridgeToExecutor(...)
  -> createSandboxBridge(...)
  -> injected command builder produces sandboxed Bun command
  -> sandboxed child worker starts
  -> host sends Execute message
  -> worker runs code and returns Result/Error message
  -> bridge validates and maps to SandboxResult/SandboxError
```

For hosted/cloud reuse:

```text
caller
  -> createSandboxBridge(...) or cached reusable bridge from @koi/sandbox-cloud-base
  -> custom transport/process implementation
  -> same typed protocol + same error/result mapping
```

The key design constraint is that `@koi/sandbox-ipc` owns the protocol, but `@koi/sandbox-cloud-base` owns the reusable helper machinery around it.

## Detailed decisions

### 1. Keep `SandboxExecutor` as the consumer-facing execution contract

We are **not** replacing `packages/kernel/core/src/sandbox-executor.ts`.

Why:

- `@koi/sandbox-executor` already ships and is referenced by current docs and tests.
- The missing value in `#1379` is not a new contract; it is the structured bridge and reusable support library around the existing contract.
- Replacing the contract would expand scope into the already-completed executor/router work tracked elsewhere.

Result:

- `@koi/sandbox-ipc` adapts *to* `SandboxExecutor`
- `@koi/sandbox-cloud-base` stays contract-neutral

### 2. Inject sandbox command building

`@koi/sandbox-ipc` must not directly import `@koi/sandbox-os` or any other peer L2 package.

So the bridge config keeps the v1 idea of an injected command builder:

- input: `SandboxProfile`, worker command, command args
- output: a concrete sandboxed process command

This preserves layering:

- `sandbox-ipc` owns bridge lifecycle and protocol
- the caller owns policy-specific process wrapping

### 3. Port only the reusable pieces of v1 cloud-base

v1 `sandbox-cloud-base` included a wider mix of helpers. In v2 we only bring forward helpers that satisfy one of these:

- already referenced by live docs/code
- needed by `sandbox-ipc`
- used by at least two cloud/backend call sites

That means the first v2 surface should include:

- cached bridge
- profile validation
- line reader
- output accumulator
- destroy/instance guards

It should **not** automatically include:

- Nexus mount helpers
- sandbox admin surfaces
- adapter factories that no current v2 package needs

### 4. Share profile validation across hosted adapters

`@koi/sandbox-daytona` and `@koi/sandbox-e2b` both contain adapter-local logic that rejects unsupported filesystem/network/resource requests.

The v2 `sandbox-cloud-base` should provide the common detection + formatting primitives so hosted adapters can say:

- which policies are unsupported
- why the backend is refusing to provision
- what kind of safer backend the caller should use instead

This reduces drift in fail-closed behavior without forcing the adapters into a shared factory abstraction.

### 5. Do not over-couple cloud adapters to IPC

The user asked that `sandbox-ipc` also expose a higher-level bridge API that cloud backends can share directly.

In v2 that means:

- cloud backends may reuse the protocol/types/error-mapping/lifecycle pattern
- they should not be forced to masquerade as local Bun-child workers
- the reusable surface lives in the bridge layer, not in a subprocess-specific wrapper

So `sandbox-ipc` exports:

- worker protocol types
- bridge config/result/error types
- bridge lifecycle primitives

But we do **not** require the existing hosted adapters to adopt it immediately in this branch. The first branch only needs to make the surface available and prove it through tests.

## File layout

### New package: `packages/lib/sandbox-cloud-base`

Planned files:

- `src/index.ts`
- `src/cached-bridge.ts`
- `src/validate-profile.ts`
- `src/line-reader.ts`
- `src/output-accumulator.ts`
- `src/guard.ts`
- `src/*.test.ts` for each helper group
- `package.json`
- `tsconfig.json`
- `tsup.config.ts`

### New package: `packages/sandbox/sandbox-ipc`

Planned files:

- `src/index.ts`
- `src/types.ts`
- `src/protocol.ts`
- `src/errors.ts`
- `src/bridge.ts`
- `src/adapter.ts`
- `src/worker-source.ts`
- `src/bridge.test.ts`
- `src/protocol.test.ts`
- `src/adapter.test.ts`
- `src/integration.test.ts`
- `package.json`
- `tsconfig.json`
- `tsup.config.ts`

### Cross-cutting repo changes

- `scripts/layers.ts` — add `@koi/sandbox-cloud-base` to `L0U_PACKAGES` and `@koi/sandbox-ipc` to `L2_PACKAGES`
- package docs:
  - `docs/L0u/sandbox-cloud-base.md`
  - `docs/L2/sandbox-ipc.md`
- optional cleanup target for a follow-up docs pass:
  - `docs/package-coverage-map.md`

## Testing strategy

All implementation follows doc → tests → code.

### Required tests for `@koi/sandbox-cloud-base`

1. `cached-bridge.test.ts`
   - lazy creation on first use
   - TTL disposal after inactivity
   - hard lifetime disposal
   - concurrent calls do not create duplicate underlying bridges
   - `dispose()` is idempotent

2. `validate-profile.test.ts`
   - permissive profiles return `undefined`
   - unsupported network/filesystem/resource policies are detected
   - error formatting is stable and adapter-name aware

3. `line-reader.test.ts`
   - NDJSON framing across chunk boundaries
   - max-line / max-total cap behavior
   - invalid JSON lines surface errors cleanly

4. `output-accumulator.test.ts`
   - byte-accurate truncation
   - combined stdout/stderr accounting if implemented that way
   - UTF-8 safety on multibyte boundaries

### Required tests for `@koi/sandbox-ipc`

1. `protocol.test.ts`
   - parse valid ready/execute/result/error messages
   - reject malformed or shape-incompatible messages

2. `bridge.test.ts`
   - happy path returns structured result
   - worker error maps to expected `IpcError`
   - bridge timeout kills child and returns `TIMEOUT`
   - oversize result returns `RESULT_TOO_LARGE`
   - dispose prevents future executions

3. `adapter.test.ts`
   - `bridgeToExecutor()` returns `SandboxExecutor`
   - IPC error mapping to `SandboxError` is stable
   - injected command builder failure propagates cleanly

4. `integration.test.ts`
   - bidirectional host↔worker execution using real Bun child
   - worker can receive input, execute code, and return output
   - failure path with thrown user code returns mapped error

### Cross-package proof

At least one hosted adapter test should switch from local profile-validation logic to the shared `sandbox-cloud-base` helper, proving that the L0u package is actually reusable.

Recommended target:

- `packages/sandbox/sandbox-e2b/src/*.test.ts`

Reason:

- it already has explicit fail-closed profile behavior
- it is simpler to prove reuse there than trying to integrate every hosted adapter at once

## Documentation impact

Implementation PRs must add:

- `docs/L0u/sandbox-cloud-base.md`
- `docs/L2/sandbox-ipc.md`

The docs should explicitly state:

- `sandbox-cloud-base` is an L0u helper library, not a user-facing runtime package
- `sandbox-ipc` is a structured execution bridge that adapts to `SandboxExecutor`
- `sandbox-executor` remains the active execution contract

The docs should also clean up stale wording that implies:

- `@koi/code-executor` still exists in the live v2 tree
- `@koi/sandbox-cloud-base` or `@koi/sandbox-ipc` already ship today when they do not

## Risks and mitigations

### Risk 1: porting too much from v1

Mitigation:

- only port helpers that are used immediately
- keep package APIs intentionally small
- no broad shared factory abstractions unless current v2 code needs them

### Risk 2: layer drift

Mitigation:

- `sandbox-cloud-base` stays in `packages/lib`
- `sandbox-ipc` must use injected command building instead of importing peer sandbox packages
- `bun run check:layers` is mandatory in implementation

### Risk 3: duplicate bridge concepts

Mitigation:

- keep `sandbox-executor` as the single code-execution contract
- define `sandbox-ipc` as a bridge implementation, not a second executor family

### Risk 4: partial cloud adoption leaves dead code

Mitigation:

- require at least one real hosted-adapter consumer in tests
- defer broader cloud integration until there is a current caller

## Delivery shape

This issue is best delivered in two implementation PRs after the spec:

1. **PR A: `@koi/sandbox-cloud-base`**
   - add package
   - add L0u registration
   - migrate one hosted adapter to shared validation helper
   - docs + tests

2. **PR B: `@koi/sandbox-ipc`**
   - add package
   - add L2 registration
   - implement bridge core, adapter, worker protocol
   - docs + tests

Reason for split:

- keeps each PR under the repo's size guidance
- lets the L0u helper package land cleanly before the L2 consumer
- gives reviewers a smaller surface for layer and API checks

## Acceptance criteria

This design is complete when the follow-up implementation delivers all of:

- `@koi/sandbox-cloud-base` exists in `packages/lib/sandbox-cloud-base`
- `@koi/sandbox-ipc` exists in `packages/sandbox/sandbox-ipc`
- `@koi/sandbox-cloud-base` is registered as L0u in `scripts/layers.ts`
- `@koi/sandbox-ipc` is registered as L2 in `scripts/layers.ts`
- `sandbox-ipc` can execute code through a real Bun child over structured IPC
- `sandbox-ipc` exposes both executor-facing and reusable higher-level bridge APIs
- at least one hosted adapter reuses `sandbox-cloud-base` profile-validation helpers
- package docs exist for both new packages
- tests cover happy path, timeout/error path, and bridge/cache lifecycle behavior

## Recommendation summary

Build a small, modern v2 `sandbox-cloud-base` plus a focused `sandbox-ipc` bridge package. Reuse the archive only where it maps cleanly onto current contracts, and let `@koi/sandbox-executor` remain the canonical code-execution surface.
