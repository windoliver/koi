# gov-8: Engine lifecycle → GovernanceController event wiring

**Issue**: [#1875](https://github.com/windoliver/koi/issues/1875)
**Parent**: #1208 (governance umbrella)
**Date**: 2026-04-17

## Motivation

`@koi/core/governance` defines a `GovernanceEvent` union with eight kinds:
`turn`, `spawn`, `spawn_release`, `forge`, `token_usage`, `tool_error`,
`tool_success`, `iteration_reset`, `session_reset`. Setpoints declared against
sensors (`spawn_count`, `turn_count`, `error_rate`, etc.) are dead code unless
the engine emits the corresponding events.

## Status of each event today

| Event | Wired? | Where |
|---|---|---|
| `turn` | yes | `engine-reconcile/src/governance-extension.ts` `onBeforeTurn` |
| `tool_success` / `tool_error` | yes | `governance-extension.ts` `wrapToolCall` |
| `token_usage` | yes | `governance-extension.ts` `wrapModelCall` + `wrapModelStream` |
| `iteration_reset` | yes | `engine/src/koi.ts:704` (#1742) |
| `session_reset` | yes | `engine/src/koi.ts:1986` (#1742) |
| `spawn` | **no** | needs `engine/src/spawn-child.ts` |
| `spawn_release` | **no** | needs `engine/src/spawn-child.ts` |
| `forge` | deferred | v2 forge package not yet built; defer to forge PR |

Roughly 85% of the original gov-8 ask shipped with #1742 and the governance
extension. This spec covers the remaining 15%: spawn/spawn_release wiring.

## Scope

**In:**
- Wire `spawn` and `spawn_release` events in `spawn-child.ts` against the
  parent agent's `GovernanceController`.
- Update obsolete comment in `governance-extension.ts:81-85` that says spawn is
  "tracked by the SpawnLedger ... no governance record needed".
- Add unit tests for the four spawn paths (success, error, terminated, no-controller).
- Extend the existing `spawn-tools` golden-replay full-loop test with a
  controller spy that asserts `spawn` and `spawn_release` events fire.
- Document the event-firing matrix in `docs/engine/governance-controller.md`.

**Out (separate issues):**
- `forge` event firing — depends on v2 forge package landing.
- Controller inheritance / budget apportionment — gov-14.
- New L2 governance variables — covered by gov-7 / contributor pattern.

## Architecture

### Wiring location

`packages/kernel/engine/src/spawn-child.ts` orchestrates child agent creation.
`childPid.depth` is only known after `createKoi()` returns successfully, so the
`spawn` record must happen after assembly succeeds — not immediately after
ledger acquire. The error-path catch fires before `childPid` exists, so there
is nothing to release on that branch:

```
1. spawnLedger.acquire()
2. createKoi(...)  ── may throw; on throw: ledger.release(); rethrow
3. ◄── insert: parent.component<GovernanceController>(GOVERNANCE)?
       └─ if present: await ctrl.record({ kind: "spawn", depth: childPid.depth })
4. registry.register(...)
5. handle.onEvent("terminated"):
       (already gated by `released = false`)
       ledger.release()
       ◄── insert: if ctrl !== undefined: ctrl.record({ kind: "spawn_release" })
6. dispose-override path (no-registry):
       (already gated by `released = false`)
       ledger.release()
       ◄── insert: if ctrl !== undefined: ctrl.record({ kind: "spawn_release" })
```

### Invariants

- **Optional governance.** If parent has no `GOVERNANCE` component, the engine
  does nothing. No throw, no warn. The L0 contract says agents may have no
  governance; the engine must work without one.
- **Idempotent release.** Both the `terminated` handler and the dispose-override
  already guard release with `released = false`. The governance record sits
  inside the same guard — cascade events that fire `terminated` twice cannot
  double-release the counter.
- **No separate pairing flag needed.** The `record(spawn)` call only happens
  after `createKoi()` succeeds. The two `spawn_release` paths both live inside
  the existing `released` guard. Either both fire (success → terminated/dispose)
  or neither fires (assembly throws before record). The existing flag is
  sufficient.
- **Depth source.** `depth` in the spawn event payload is the **child's** depth
  (`childPid.depth`). The current controller implementation ignores `depth` in
  `record()` (it only increments `spawn_count`); `depth` is informational, used
  by future contributors and by audit sinks that consume the event stream.
  Recording the child's depth matches the natural reading of the event — "a
  child was spawned at depth N".
- **Controller capture.** Resolve `parent.component<GovernanceController>(GOVERNANCE)`
  once after `createKoi()` succeeds; capture the reference in a local. Both
  release paths read the same local. This avoids re-resolving in the cleanup
  handler (where the parent could theoretically have been disposed).

### Comment cleanup

`governance-extension.ts:81-85` currently reads:

```typescript
// Spawn concurrency is tracked by the SpawnLedger in spawn-child.ts
// (acquire on spawn, release on child termination). No governance record
// needed here — recording { kind: "spawn" } without a corresponding
// spawn_release would make the counter monotonically increasing, turning
// maxFanOut into "max total spawns ever" instead of "max concurrent children".
```

Replace with a one-line pointer to spawn-child.ts:

```typescript
// Spawn / spawn_release are recorded directly in spawn-child.ts against the
// parent's GovernanceController (paired with ledger acquire / release).
```

## Tests

### Unit — `packages/kernel/engine/src/spawn-child.test.ts`

Four new cases. Reuse the existing `parentAgent` mock; add a mock controller
with a `record` spy.

1. **`spawn` event recorded after assembly succeeds, with `depth: childPid.depth`.**
   Spy receives one call: `{ kind: "spawn", depth: 1 }` (parent at depth 0).
2. **`spawn_release` recorded when child `terminated` event fires.**
   Spy receives `{ kind: "spawn_release" }` exactly once after termination.
3. **`spawn_release` recorded when dispose-override fires (no-registry path).**
   Same shape; verifies the alternate cleanup path.
4. **No-op when parent has no `GOVERNANCE` component.**
   Mock parent returns `undefined` from `component(GOVERNANCE)`; spy is never
   called; spawn still succeeds.

### Integration — `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

Extend the existing `Full-loop replay: spawn-tools cassette` test (line ~5551):

- Attach a controller spy via a custom `ComponentProvider` that replaces the
  default governance controller with a wrapping spy.
- After `spawn-tools.cassette.json` replays end-to-end, assert:
  - At least one `spawn` event was recorded with `depth: 1`.
  - At least one matching `spawn_release` event was recorded.
  - Counts match (`spawn_count == spawn_release_count`) once all children
    terminate.

No new cassette recording needed — `spawn-tools.cassette.json` already exercises
real spawn flows.

## Files touched

| File | Change | Est LOC |
|---|---|---|
| `packages/kernel/engine/src/spawn-child.ts` | Resolve parent controller; record `spawn` after `createKoi`; record `spawn_release` in terminated + dispose-override paths | ~25 |
| `packages/kernel/engine-reconcile/src/governance-extension.ts` | Update obsolete comment (line 81-85) | ~3 |
| `packages/kernel/engine/src/spawn-child.test.ts` | 4 new unit cases | ~80 |
| `packages/meta/runtime/src/__tests__/golden-replay.test.ts` | Extend spawn-tools test with controller spy + assertions | ~25 |
| `docs/engine/governance-controller.md` | Add "Event firing matrix" section; note `forge` deferred | ~30 |

**Total: ~165 LOC** vs issue's ~350 estimate (lower because most events
already wired).

## CI gate

All v2 quality gates apply:

```bash
bun run test --filter=@koi/engine
bun run test --filter=@koi/runtime
bun run typecheck
bun run lint
bun run check:layers
```

No new L2 package, so `check:orphans` / `check:golden-queries` are not
triggered.

## Out-of-scope follow-ups

- **gov-8b (forge wiring)**: open a follow-up issue when v2 forge package is
  scaffolded; emit `{ kind: "forge", toolName }` from `createForgeTool`.
- **gov-14 (budget apportionment)**: separate issue handles parent → child
  controller inheritance with attenuated limits.
