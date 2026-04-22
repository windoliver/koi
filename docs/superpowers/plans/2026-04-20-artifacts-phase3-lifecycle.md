# Artifacts Plan 3 — Lifecycle (TTL / quota / retention / sweep / scavenger)

> **Implementer note:** All design decisions, invariants, and race analyses live in `docs/superpowers/specs/2026-04-18-artifacts-design.md`. Cross-reference sections are noted per task. This plan is the execution decomposition — read the spec section before starting each task.

**Goal:** Turn the Plan 2 `ArtifactStore` from "save/get/list/delete/share/revoke with no retention" into a lifecycle-managed store with TTL-per-row, per-session quota, per-name version retention, a two-phase crash-safe sweep, and an orphan-blob scavenger.

**Architecture:** Policy is immutable per store open (§4 `ArtifactStoreConfig.policy`). Save-side wiring stamps `expires_at` and enforces quota. Sweep runs in two transactions: Phase A (metadata → tombstones, all inside one `BEGIN IMMEDIATE`) and Phase B (claim-delete-reconcile loop, with blob I/O outside the DB lock). Scavenger rebuilds the tombstone journal from `blobStore.list()` and hands off to Phase B — it never deletes blobs directly.

**Tech Stack:** same as Plan 2 (Bun + bun:sqlite + @koi/blob-cas).

---

## File Structure

### Create

- `packages/lib/artifacts/src/policy.ts` — validate + normalize `LifecyclePolicy`; freeze-at-save helper that computes `expires_at` from `ttlMs + createdAt` (frozen so policy changes don't retroactively reclaim existing rows)
- `packages/lib/artifacts/src/quota.ts` — per-session byte accounting read (`SELECT SUM(size) WHERE session_id = ?`) + reserve helper
- `packages/lib/artifacts/src/sweep.ts` — `sweepArtifacts()` Phase A (metadata sweep → tombstones) + entry point that drives Phase B
- `packages/lib/artifacts/src/drain-tombstones.ts` — Phase B claim/delete/reconcile loop (shared by `sweepArtifacts` + scavenger)
- `packages/lib/artifacts/src/scavenger.ts` — `scavengeOrphanBlobs()` rebuilds tombstones from `blobStore.list()`
- `packages/lib/artifacts/src/__tests__/policy.test.ts`
- `packages/lib/artifacts/src/__tests__/quota.test.ts`
- `packages/lib/artifacts/src/__tests__/sweep.test.ts`
- `packages/lib/artifacts/src/__tests__/drain-tombstones.test.ts`
- `packages/lib/artifacts/src/__tests__/scavenger.test.ts`

### Modify

- `packages/lib/artifacts/src/types.ts` — remove Plan-2 guard comment about `policy`; re-export `LifecyclePolicy` from `@koi/artifacts/index.ts`
- `packages/lib/artifacts/src/create-store.ts` — drop the `policy is not supported` runtime guard; thread validated policy into save + new sweep path
- `packages/lib/artifacts/src/schema.ts` — add `claimed_at INTEGER` column to `pending_blob_deletes` (spec §6.3); bump schema version
- `packages/lib/artifacts/src/save.ts` — (a) call `policy.computeExpiresAt(createdAt)` and persist `expires_at`; (b) run quota check before journaling intent; (c) reclaim tombstone path: if a `pending_blob_deletes` row exists for the hash with `claimed_at IS NOT NULL`, flip `needsRePut = true` per spec §6.3
- `packages/lib/artifacts/src/list.ts` — sweep deleted rows are tombstoned, not immediately removed — verify no read path depends on cascade delete before tombstone drains
- `packages/lib/artifacts/src/sqlite.ts` — migration hook for `claimed_at` column
- `packages/lib/artifacts/src/index.ts` — export `sweepArtifacts` and `scavengeOrphanBlobs` as `ArtifactStore` methods (already declared in spec §4)
- `docs/L2/artifacts.md` — add "Lifecycle" section (policy shape + sweep semantics + scavenger disclaimer)

### Test (additions to existing files)

- `packages/lib/artifacts/src/__tests__/save.test.ts` — freeze-at-save TTL; quota rejection; tombstone-reclaim path
- `packages/lib/artifacts/src/__tests__/create-store.test.ts` — policy validation surfaces through `ArtifactStoreConfig`; accepts valid policy

---

## Task Decomposition

### Task 1: `LifecyclePolicy` validation + freeze-at-save helper

**Files:** create `src/policy.ts` + `src/__tests__/policy.test.ts`; modify `src/types.ts` (no-op — already declared).

Validate: all three fields optional; when present must be finite positive integers; reject `Number.NaN`, negatives, zero, fractions. Provide `computeExpiresAt(createdAt: number, policy?: LifecyclePolicy): number | null` — returns `createdAt + policy.ttlMs` when ttlMs set, else `null`. Freeze semantics: the value returned is persisted on the row, never recomputed later.

- [ ] Test: rejects negative / NaN / infinity / fractional `ttlMs`
- [ ] Test: rejects invalid `maxSessionBytes`
- [ ] Test: rejects invalid `maxVersionsPerName`
- [ ] Test: accepts all-undefined policy (no-op)
- [ ] Test: `computeExpiresAt` returns `createdAt + ttlMs` when set
- [ ] Test: `computeExpiresAt` returns null when `ttlMs` is undefined
- [ ] Implement `validateLifecyclePolicy` + `computeExpiresAt` (together < 50 lines)
- [ ] Wire `validateLifecyclePolicy` call into `createArtifactStore` config validation; remove the Plan-2 guard that rejects `policy` at runtime
- [ ] Run: `bun test packages/lib/artifacts/src/__tests__/policy.test.ts`

### Task 2: Quota accounting + save-side enforcement

**Files:** create `src/quota.ts` + `src/__tests__/quota.test.ts`; modify `src/save.ts` + `src/__tests__/save.test.ts`.

`readSessionBytes(db, sessionId)` = `SELECT COALESCE(SUM(size), 0) FROM artifacts WHERE session_id = ? AND blob_ready = 1`. Called from save protocol before journaling intent. If `used + input.data.length > maxSessionBytes`, return `Result<_, { kind: "quota_exceeded", sessionId, usedBytes, limitBytes }>` — no intent is journaled, no blob I/O happens.

Exclude `blob_ready = 0` rows — they're in-flight and may fail. Counting them would reject saves below the real limit during repair.

- [ ] Test: empty session returns 0 bytes
- [ ] Test: sum matches committed rows
- [ ] Test: `blob_ready=0` rows excluded from total
- [ ] Test: save succeeds when under quota
- [ ] Test: save returns `quota_exceeded` with accurate `usedBytes` + `limitBytes` when over
- [ ] Test: failed save (quota) leaves no intent journaled
- [ ] Implement `readSessionBytes`
- [ ] Thread quota check into `saveArtifact` before step 3 of §6.1
- [ ] Run: `bun test packages/lib/artifacts/src/__tests__/quota.test.ts packages/lib/artifacts/src/__tests__/save.test.ts`

### Task 3: Schema migration — `claimed_at` column on `pending_blob_deletes`

**Files:** modify `src/schema.ts`, `src/sqlite.ts`; update `src/__tests__/schema.test.ts` + `src/__tests__/migration.test.ts`.

The design's Phase B uses `claimed_at IS NULL` as a predicate. Plan 2 schema doesn't have the column. Add it via a schema-version bump (migration must be safe on a DB that has active rows from Plan-2 runtime).

- [ ] Test: new store creates column `claimed_at INTEGER` with NULL default
- [ ] Test: migrating a Plan-2 DB adds the column and preserves existing rows
- [ ] Test: idempotent — running migration twice is a no-op
- [ ] Implement schema bump + migration step
- [ ] Run: `bun test packages/lib/artifacts/src/__tests__/schema.test.ts packages/lib/artifacts/src/__tests__/migration.test.ts`

### Task 4: Expires-at population in save protocol

**Files:** modify `src/save.ts`, `src/__tests__/save.test.ts`.

Call `computeExpiresAt(createdAt, config.policy)` during the metadata insert; persist the result into `artifacts.expires_at`. Freeze semantics means the computed timestamp is the value for the row — later policy changes do not touch existing rows. When policy omits `ttlMs`, persist `NULL`.

- [ ] Test: no-policy save persists `expires_at = NULL`
- [ ] Test: `ttlMs=1000` at `createdAt=T` persists `expires_at = T + 1000`
- [ ] Test: two saves by the same session with different clock tick get different `expires_at`
- [ ] Implement wiring
- [ ] Run save tests

### Task 5: Phase A — `sweepArtifacts()` metadata sweep

**Files:** create `src/sweep.ts` + `src/__tests__/sweep.test.ts`; modify `src/create-store.ts` to expose `sweepArtifacts()` via the store handle.

Per spec §6.3 steps 1–6:

1. `BEGIN IMMEDIATE`
2. Compute deletion set from policy, scanning only `blob_ready = 1`:
   - TTL-expired: `expires_at IS NOT NULL AND expires_at < now`
   - Quota excess per session: oldest-first until under `maxSessionBytes`
   - Retention excess per `(session_id, name)`: drop oldest when `COUNT(*) > maxVersionsPerName`
3. Collect `candidateHashes` = distinct `content_hash` values whose only references are inside the deletion set
4. `DELETE FROM artifacts WHERE id IN (...)` — `ON DELETE CASCADE` removes share grants
5. For each hash: `INSERT INTO pending_blob_deletes(hash, enqueued_at) VALUES (?, ?) ON CONFLICT DO NOTHING`
6. `COMMIT`

Return `{ deleted, bytesReclaimed }` summed over the deletion set. Do NOT perform blob I/O in Phase A — the returned `bytesReclaimed` is the metadata-level size total; actual blob-on-disk reclamation happens in Phase B.

- [ ] Test: no-op when policy is empty
- [ ] Test: TTL-expired rows reaped
- [ ] Test: in-flight (`blob_ready=0`) rows NOT candidates (protects active saves)
- [ ] Test: quota excess — oldest rows dropped first until under limit
- [ ] Test: retention excess — oldest versions per `(session,name)` dropped, latest N kept
- [ ] Test: shared artifact's share row cascades on row delete
- [ ] Test: hash referenced by a surviving row is NOT tombstoned
- [ ] Test: hash referenced only by deleted rows IS tombstoned (exactly once — `ON CONFLICT DO NOTHING`)
- [ ] Test: crash between row DELETE and tombstone INSERT is impossible (both in same tx)
- [ ] Implement Phase A in `createSweepArtifacts({ db, policy })`
- [ ] Wire into store handle + expose on `ArtifactStore.sweepArtifacts`
- [ ] Run: `bun test packages/lib/artifacts/src/__tests__/sweep.test.ts`

### Task 6: Phase B — tombstone drain (claim/delete/reconcile)

**Files:** create `src/drain-tombstones.ts` + `src/__tests__/drain-tombstones.test.ts`; modify `src/sweep.ts` to call drain after Phase A.

Per spec §6.3 Phase B, three tiny transactions per tombstone:

1. **Claim tx:** `UPDATE pending_blob_deletes SET claimed_at = now WHERE hash = ? AND claimed_at IS NULL AND NOT EXISTS (artifacts WHERE content_hash = ?) AND NOT EXISTS (pending_blob_puts WHERE hash = ?)` — if 0 rows affected, cleanup orphan tombstones (concurrent save may have reclaimed) and continue.
2. **Blob I/O:** `await blobStore.delete(hash)` outside any DB lock. ENOENT / 404 = success. Timeouts leave claimed tombstone for next retry (resume-from-claimed rule).
3. **Reconcile tx:** `DELETE FROM pending_blob_deletes WHERE hash = ?`. If 0 changes, a concurrent save reclaimed between steps 1 and 3 — the save's post-commit put handles re-creation.

Drive the loop from `SELECT hash FROM pending_blob_deletes ORDER BY enqueued_at`.

Resume-from-claimed: if a tombstone is already `claimed_at != NULL` on first scan, treat it as still-claimed (crash between claim and reconcile); retry the delete and reconcile.

- [ ] Test: claims unclaimed tombstone → deletes blob → reconciles row
- [ ] Test: claim fails when live artifact row references hash → tombstone cleaned up
- [ ] Test: claim fails when pending_blob_puts intent references hash → tombstone stays
- [ ] Test: `blobStore.delete` returns ENOENT/404 → treated as success
- [ ] Test: `blobStore.delete` throws → tombstone retains `claimed_at`, next drain retries (resume-from-claimed)
- [ ] Test: concurrent `saveArtifact` reclaiming tombstone mid-drain — reconcile finds 0 changes, save completes via post-commit re-put
- [ ] Test: idempotent across restarts — running the same pending state twice yields identical outcome
- [ ] Implement `drainPendingBlobDeletes({ db, blobStore })`
- [ ] Wire into end of `sweepArtifacts()` (Phase A → Phase B in sequence for now; Plan 4 moves Phase B to background worker)
- [ ] Run: `bun test packages/lib/artifacts/src/__tests__/drain-tombstones.test.ts`

### Task 7: Save-side tombstone reclaim

**Files:** modify `src/save.ts` + `src/__tests__/save.test.ts`.

Per spec §6.1 step 5 + §6.3 race analysis, when a save's content hash has a live `pending_blob_deletes` row with `claimed_at IS NOT NULL`, the save observed that a Phase B claim is in flight and MUST re-put the bytes unconditionally after the metadata commit. Mechanics:

- During save's BEGIN IMMEDIATE tx, SELECT tombstone state for the hash.
- If exists + claimed_at NULL → normal reclaim: DELETE tombstone in same tx.
- If exists + claimed_at NOT NULL → keep tombstone (Phase B already owns it); set `needsRePut = true`; after COMMIT, regardless of `blobStore.has(hash)`, call `blobStore.put(data)` to re-create bytes that Phase B may have already deleted.
- If not exists → normal path.

- [ ] Test: save with hash matching claimed tombstone re-puts bytes after commit
- [ ] Test: save with hash matching unclaimed tombstone DELETEs tombstone in its tx (no re-put needed)
- [ ] Test: save with fresh hash takes normal path (no tombstone interaction)
- [ ] Test: concurrent Phase B + save with same hash — save's re-put wins, final state: blob present, row blob_ready=1, no tombstone
- [ ] Implement reclaim branch + post-commit re-put
- [ ] Run save tests

### Task 8: Scavenger — `scavengeOrphanBlobs()`

**Files:** create `src/scavenger.ts` + `src/__tests__/scavenger.test.ts`; wire into store handle.

Per spec §6.4. Rebuilds tombstone journal from backing store, then reuses Phase B. Never deletes blobs directly.

1. `pass1_live` = distinct hashes from `artifacts.content_hash ∪ pending_blob_deletes.hash ∪ pending_blob_puts.hash`
2. Walk `blobStore.list()`; for each hash not in `pass1_live`, append to `candidates`
3. `BEGIN IMMEDIATE`; `INSERT OR IGNORE` each candidate into `pending_blob_deletes`; `COMMIT`
4. Drive `drainPendingBlobDeletes` (Phase B)

The `pending_blob_puts` clause is load-bearing: a save that put the blob but hasn't yet INSERTed its row is tracked in `pending_blob_puts` and must be treated as live.

- [ ] Test: no-op when every blob has a live reference
- [ ] Test: stranded blob (no row, no pending) → journaled + deleted via Phase B
- [ ] Test: blob referenced only by `pending_blob_puts` → preserved (in-flight save)
- [ ] Test: concurrent save interleaving — save journals intent after `pass1_live` snapshot; claim predicate rejects delete
- [ ] Test: returns `{ deleted, bytesReclaimed }` reflecting actual Phase B drain outcome
- [ ] Implement
- [ ] Expose on store handle
- [ ] Run: `bun test packages/lib/artifacts/src/__tests__/scavenger.test.ts`

### Task 9: Expose `sweepArtifacts` + `scavengeOrphanBlobs` on the public store

**Files:** modify `src/create-store.ts`, `src/__tests__/create-store.test.ts`.

Wire both methods through the mutation-barrier (already present in Plan 2 — they must be tracked by `inFlight` so `close()` drains them).

- [ ] Test: `sweepArtifacts` and `scavengeOrphanBlobs` each tracked by mutation barrier
- [ ] Test: `close()` awaits in-flight sweep before closing SQLite
- [ ] Test: calling after `close()` rejects with "ArtifactStore is closed"
- [ ] Implement

### Task 10: Doc update

**Files:** modify `docs/L2/artifacts.md`.

Add a "Lifecycle" section covering: the three policy knobs, freeze-at-save semantics, two-phase sweep protocol, scavenger disclaimer. One paragraph per topic — reference spec §6.3 / §6.4 for the race analysis, don't duplicate it here.

- [ ] Update doc
- [ ] Run: `bun run check:doc-wiring` + `bun run check:doc-sync`

### Task 11: CI gate sweep

- [ ] `bun run --cwd packages/lib/artifacts typecheck`
- [ ] `bun run --cwd packages/lib/artifacts test` — all new + all existing tests green
- [ ] `bun run check:layers`
- [ ] `bun run check:orphans`
- [ ] `bun run check:golden-queries` — this Plan doesn't add an agent-facing tool but re-verifies coverage
- [ ] `bun run --cwd packages/meta/runtime test` — confirm Plan 2 goldens still pass post-schema migration

---

## Self-Review Checklist

Before handing off:

- **Spec coverage:** §6.3 Phase A + B + race table + resume-from-claimed; §6.4 scavenger; §4 `ArtifactStoreConfig.policy` (validated); `LifecyclePolicy` exported
- **No placeholders:** every test step shows the actual code
- **Type consistency:** `LifecyclePolicy` fields match spec exactly; `ArtifactError` discriminant `"quota_exceeded"` fields match spec exactly
- **Frozen-TTL invariant:** `expires_at` is computed at save time, not read time — a test explicitly forbids reading the live policy during get/list

## Out of Scope (Plan 4+)

- Background worker that drives Phase B without blocking callers → Plan 4 (#1921)
- Hot-reloadable policy → never (policy is immutable per store open — simplifies every correctness argument)
- Per-call `sweepArtifacts(policy)` override → spec §6.3 rules this out explicitly (`reads and sweep can never disagree`)
