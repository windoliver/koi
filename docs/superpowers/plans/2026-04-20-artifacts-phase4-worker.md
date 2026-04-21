# Artifacts Plan 4 — Full startup recovery + background repair worker

> **Implementer note:** All invariants are in `docs/superpowers/specs/2026-04-18-artifacts-design.md`. Plan 4 scope is §6.5 (steps 1–5) — the current Plan 2 `runStartupRecovery` is minimal; this plan finishes it. Cross-reference §6.3 race analysis and §6.1 save protocol as needed.

**Goal:** Finish §6.5 startup recovery and add the background worker that drains `blob_ready = 0` rows + `pending_blob_deletes` asynchronously so `createArtifactStore` returns fast and long-running hosts reap stale work over time.

**Architecture:** Open path runs only local SQLite DML: (a) pending_blob_puts grace-window drain → convert stale intents to tombstones, (b) TTL-only Phase A sweep. Blob I/O is exclusively in the background worker which spawns after open returns. Close barrier awaits the worker's current iteration to finish and cancels future ticks.

**Tech Stack:** same as Plan 2/3.

---

## File Structure

### Create

- `packages/lib/artifacts/src/worker.ts` — `createRepairWorker({ db, blobStore, config })` returning `{ start(), stop(): Promise<void>, runOnce(): Promise<WorkerStats>, active(): boolean }`
- `packages/lib/artifacts/src/__tests__/worker.test.ts`

### Modify

- `packages/lib/artifacts/src/recovery.ts` — expand to §6.5 step 1 (grace window drain converting stale intents to tombstones) + expose a `sweepTtlOnOpen({ db })` helper for §6.5 step 3. Blob probes are REMOVED from the open path — those move into the worker.
- `packages/lib/artifacts/src/__tests__/recovery.test.ts` — update tests to reflect new open-path invariants (no blob I/O on open)
- `packages/lib/artifacts/src/create-store.ts` — call recovery + TTL sweep synchronously, then start the worker. Close barrier awaits `worker.stop()`.
- `packages/lib/artifacts/src/types.ts` — add `workerIntervalMs?: number | "manual"` + `staleIntentGraceMs?: number` to `ArtifactStoreConfig`; add `repair_exhausted` to structured log surface if we expose one
- `packages/lib/artifacts/src/drain-tombstones.ts` — add a `drainBlobReadyZero({ db, blobStore, maxRepairAttempts })` helper invoked by the worker (keep the existing Phase B drain as-is)

### Test

- `packages/lib/artifacts/src/__tests__/recovery.test.ts` — stale pending_blob_puts → tombstone conversion; TTL-only sweep on open (quota + retention NOT applied)
- `packages/lib/artifacts/src/__tests__/worker.test.ts` — blob_ready=0 drain (3 branches: has=true → promote, has=false → increment+terminal-at-budget, transient → no increment + retry); phase B drain loop; start/stop lifecycle; close barrier
- `packages/lib/artifacts/src/__tests__/save.test.ts` — regression: save through worker-active store still works

---

## Task Decomposition

### Task 1: Grace window + stale-intent conversion in startup recovery

**Files:** modify `recovery.ts` + `recovery.test.ts`.

Spec §6.5 step 1: `pending_blob_puts` rows older than `staleIntentGraceMs` (default 5 min) get handled atomically:
- If hash already has an `artifacts` row (any `blob_ready` state) → just `DELETE FROM pending_blob_puts WHERE intent_id = ?`
- Else → `DELETE FROM pending_blob_puts WHERE intent_id = ?` **AND** `INSERT OR IGNORE INTO pending_blob_deletes(hash, enqueued_at) VALUES (?, now)` in the same BEGIN IMMEDIATE tx

Grace window is the critical safety bound: the default must exceed worst-case save latency so a real in-flight save is never mistaken for stale. Make it configurable so tests can drop it to 0 for deterministic checks.

Rows younger than grace window are left alone — the save may still be completing.

- [ ] Test: stale intent WITH existing artifacts row → intent deleted, no tombstone
- [ ] Test: stale intent WITHOUT artifacts row → intent deleted AND tombstone enqueued (`INSERT OR IGNORE`)
- [ ] Test: intent within grace window NOT touched
- [ ] Test: `staleIntentGraceMs = 0` (test override) makes every intent stale
- [ ] Implement `drainStalePendingIntents({ db, staleIntentGraceMs, now })`
- [ ] Run: `bun test src/__tests__/recovery.test.ts`

### Task 2: Remove blob probes from open path + add TTL-only sweep

**Files:** modify `recovery.ts` + `recovery.test.ts` + `create-store.ts`.

Spec §6.5 contract: `createArtifactStore` must NEVER call `blobStore.has()` / `put()` / `delete()` on the critical path. Current Plan 2 `runStartupRecovery` does. Gut those probes — they move to the worker in Task 4.

Add `sweepTtlOnOpen({ db, now })`: Phase A metadata sweep, TTL-expired rows only (NOT quota, NOT retention). Single BEGIN IMMEDIATE → tombstone INSERT. Same reference-check pattern as Plan 3 sweep. `blob_ready = 0` rows still excluded.

- [ ] Test: open path never calls `blobStore.has/put/delete` (instrument or inject a counting mock)
- [ ] Test: TTL-expired rows reaped at open
- [ ] Test: quota-over rows NOT reaped at open (only via explicit sweepArtifacts())
- [ ] Test: retention-excess NOT reaped at open
- [ ] Test: blob_ready=0 rows NOT reaped at open (worker handles them)
- [ ] Implement `sweepTtlOnOpen`
- [ ] Remove blob probe calls from `recovery.ts`
- [ ] Update create-store.ts to call both helpers synchronously before returning the store handle

### Task 3: Worker scaffolding (start / stop / lifecycle)

**Files:** create `worker.ts` + `worker.test.ts`; modify `create-store.ts`.

`createRepairWorker({ db, blobStore, config })` returns:
- `start(): void` — kicks off the interval loop (idempotent; repeated starts are a no-op)
- `stop(): Promise<void>` — signals shutdown and awaits the current iteration (if any) to finish
- `runOnce(): Promise<WorkerStats>` — runs one iteration; used by tests and by the close barrier to flush before shutdown
- `active(): boolean` — true iff an iteration is in flight

Config: `workerIntervalMs` (default 30_000ms, `"manual"` to disable interval scheduling for tests). When `"manual"`, only `runOnce()` triggers work.

Iteration body (Task 4 + 5 implement actual work):
```
async iteration():
  if closing: return
  # Single-flight guarantee: a second scheduled tick or runOnce() call that
  # lands here while inFlight is set returns the same promise — no double
  # execution of drains against the same rows. All callers observe the same
  # WorkerStats.
  if inFlight: return inFlight
  active = true
  try:
    await drainBlobReadyZero(...)
    await drainPendingBlobDeletes(...)  // existing Phase B from Plan 3
  finally:
    active = false
```

Interval scheduling via `setInterval`. On `stop()`, `clearInterval` executes synchronously and cancels every pending macrotask tick before any next tick fires; we then `await` the in-flight iteration promise (if any). This gives `stop()` a clean happens-before: no scheduled tick can begin after `stop()` returns, so the close barrier reliably drains the final iteration.

- [ ] Test: start → runOnce → stats returned
- [ ] Test: start is idempotent (second start is no-op)
- [ ] Test: stop awaits in-flight iteration (simulate a slow iteration, assert stop resolves only after iteration resolves)
- [ ] Test: after stop, start throws "worker stopped"
- [ ] Test: `workerIntervalMs = "manual"` — no scheduled iterations; runOnce works
- [ ] Implement worker factory with start/stop/runOnce/active
- [ ] Run: `bun test src/__tests__/worker.test.ts`

### Task 4: `drainBlobReadyZero` — blob_ready = 0 repair loop

**Files:** modify `drain-tombstones.ts` (or add a new `drain-blob-ready-zero.ts` — implementer's choice); add tests.

Spec §6.5 step 4a: walk `blob_ready = 0` rows. For each:
- `await blobStore.has(content_hash)`
  - **true (blob present):** `UPDATE artifacts SET blob_ready = 1 WHERE id = ?` (race-safe — if the save's own repair landed first, the UPDATE is a no-op)
  - **false (confirmed absent):** atomic `UPDATE artifacts SET repair_attempts = repair_attempts + 1 WHERE id = ?`. If the new value ≥ `maxRepairAttempts`, **force-resolve**: DELETE the row + INSERT tombstone for the hash (within a single tx).
  - **throw / timeout (transient):** log structured warning, leave row at `blob_ready = 0`, do NOT increment `repair_attempts`. Backoff handled at the iteration level.

The distinction between confirmed-absent and transient is what makes an hour-long S3 outage safe: only confirmed-missing observations consume the terminal-delete budget.

Row query: `SELECT id, content_hash, repair_attempts FROM artifacts WHERE blob_ready = 0`.

- [ ] Test: blob present → row promoted to blob_ready=1
- [ ] Test: blob absent below budget → repair_attempts incremented, row stays at 0
- [ ] Test: blob absent at-or-above budget → row deleted + tombstone inserted
- [ ] Test: blobStore.has throws → repair_attempts NOT incremented, row stays at 0
- [ ] Test: terminal-delete is atomic (DELETE + tombstone INSERT in one tx)
- [ ] Test: concurrent save's own repair races worker — worker's UPDATE is a no-op, save's UPDATE wins, no double-promotion
- [ ] Implement `drainBlobReadyZero`
- [ ] Run tests

### Task 5: Wire worker.iteration() to drain both queues

**Files:** modify `worker.ts` + tests.

Iteration body (sequence matters — finish in-flight repair before reclaiming tombstones):
```
1. await drainBlobReadyZero({ db, blobStore, maxRepairAttempts })
2. await drainPendingBlobDeletes({ db, blobStore })
```

Spec §6.5 step 4 explicitly orders this: (a) blob_ready=0 drain, then (b) Phase B drain. This matters because a terminal-delete in (a) produces a tombstone that (b) consumes — same iteration handles both halves.

Worker stats shape:
```ts
interface WorkerStats {
  readonly promoted: number;         // blob_ready=0 → 1
  readonly terminallyDeleted: number; // budget-exhausted rows reaped
  readonly transientErrors: number;  // has()/delete() throws
  readonly tombstonesDrained: number;
  readonly bytesReclaimed: number;   // 0 for now (see Plan 3 Task 8 limitation)
}
```

- [ ] Test: iteration runs both drains in order
- [ ] Test: terminal-delete in drain-blob-ready-zero produces tombstone that same iteration's Phase B drains
- [ ] Test: iteration aggregates stats correctly
- [ ] Implement

### Task 6: Close-barrier integration

**Files:** modify `create-store.ts` + `worker.ts` + `create-store.test.ts`.

Mutation barrier must count worker iterations toward `inFlight`. Close sequence:
1. Flip `closing = true` — public APIs start rejecting
2. `await worker.stop()` — stop scheduling new iterations, await the current one
3. Await existing in-flight counter → 0
4. `db.close()`
5. Release lock

The worker must self-check `closing` at iteration start and abort early if flipped.

- [ ] Test: close() during active worker iteration blocks until iteration finishes
- [ ] Test: no worker ticks after close() resolves (verify via a counting mock on blobStore)
- [ ] Test: close() is idempotent even with worker running
- [ ] Implement
- [ ] Run full artifacts suite

### Task 7: Structured log surface for repair_exhausted + transient errors

**Files:** modify `worker.ts` + optionally `types.ts`.

Spec §6.5 mentions `artifacts.repair_exhausted` log events. Keep this minimal for Plan 4: accept an optional `onEvent` callback in `ArtifactStoreConfig` that receives structured events (`{ kind: "repair_exhausted", artifactId, contentHash }` or `{ kind: "transient_repair_error", artifactId, contentHash, error }`). Default: no-op (operator opts in). This avoids mandatory console noise while giving hosts a hook.

- [ ] Test: `onEvent` fires with `repair_exhausted` when budget exhausted
- [ ] Test: `onEvent` fires with `transient_repair_error` when has() throws
- [ ] Test: no events when no drift happens
- [ ] Test: omitting `onEvent` is a no-op (no throws)
- [ ] Implement callback threading
- [ ] Run worker tests

### Task 8: Doc update

**Files:** modify `docs/L2/artifacts.md` + `docs/L3/runtime.md` + `docs/L3/cli.md`.

Add "Startup recovery + background worker" section covering:
- Open path is local-only — no blob I/O
- `staleIntentGraceMs` default + why 5 min
- Worker interval default + `"manual"` for tests
- `repair_attempts` semantics (confirmed-absent only counts)
- `onEvent` hook shape + operator use cases
- Close barrier awaits current iteration

Cross-reference spec §6.5 for the full protocol — don't restate the race analysis.

- [ ] Update L2 doc
- [ ] Bump L3 Plans 1+2+3 → 1-4 roll-up
- [ ] Run `bun run check:doc-wiring`

### Task 9: CI gate sweep

- [ ] `bun run --cwd packages/lib/artifacts typecheck`
- [ ] `bun run --cwd packages/lib/artifacts test`
- [ ] `bun run --cwd packages/meta/runtime test`
- [ ] `bun run --cwd packages/meta/cli test`
- [ ] `bun run check:layers check:orphans check:golden-queries check:doc-sync check:doc-gate check:doc-wiring`

---

## Self-Review Checklist

- **Open path never calls blobStore methods.** Verify with a counting spy in tests.
- **Grace window is a safety, not a performance bound.** 5 min is the floor; tests can shorten it but production never shortens.
- **Repair_attempts only increments on confirmed-absent.** Transient throws must NOT count — a one-hour outage must not reap committed artifacts.
- **Worker ordering: blob_ready=0 drain BEFORE Phase B.** Same iteration picks up any terminal-delete tombstones.
- **Close barrier includes worker.** `close()` must await the current iteration.

## Out of Scope

- Prometheus/OTel metrics — hook surface via `onEvent` is enough for Plan 4
- Adaptive backoff on transient errors — fixed interval is fine for now
- Per-session worker scheduling — one worker per store
- Multi-process coordination — single-writer lock from Plan 2 prevents concurrent workers on the same store
