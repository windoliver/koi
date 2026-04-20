# @koi/artifacts

Versioned, session-scoped file lifecycle for agent-created outputs. Metadata in SQLite, bytes in a content-addressed blob store (`@koi/blob-cas`), single-writer advisory lock, crash-safe save protocol.

This is Plan 2 of issue #1651. Plan 3 (#1920) added TTL + quota lifecycle — see [Lifecycle](#lifecycle). Plan 4 (#1921) will add background repair. Plan 5 (#1922) will add pluggable backends (S3). Plan 6 (#1923) will ship agent-facing tool governance.

## Public surface

```ts
import { createArtifactStore } from "@koi/artifacts";

const store = await createArtifactStore({
  dbPath: "/path/to/store.db",
  blobDir: "/path/to/blobs",
});

// save → get → list → delete → share → revoke → sweep → scavenge → close
await store.saveArtifact({ sessionId, name, data, mimeType, tags });
await store.getArtifact(id, { sessionId });
await store.listArtifacts(filter, { sessionId });
await store.deleteArtifact(id, { sessionId });
await store.shareArtifact(id, withSessionId, { ownerSessionId });
await store.revokeShare(id, fromSessionId, { ownerSessionId });
await store.sweepArtifacts();      // apply lifecycle policy (Plan 3)
await store.scavengeOrphanBlobs(); // disaster-recovery only (Plan 3)
await store.close();
```

Every expected failure returns `Result<T, ArtifactError>` per the project's error policy — never a throw. `ArtifactError.kind` is one of `not_found | quota_exceeded | invalid_input`. Non-owner access always surfaces as `not_found` to prevent probe-style existence disclosure.

## Layered architecture

```
@koi/artifacts           (L2, this package)
   │
   ├─ @koi/blob-cas            (L0u — content-addressed filesystem store)
   └─ @koi/core                (L0 — ArtifactId, SessionId, Result types)
```

Storage is split on purpose: metadata (who owns what, version chain, share grants) lives in SQLite; blobs live in a separate CAS backend addressable by SHA-256. The two layers pair via a store-id fingerprint so a stale SQLite can never be re-paired with a fresh blob backend (or vice versa).

## Data model

### Metadata schema (SQLite, 5 tables)

| Table | Purpose |
|---|---|
| `artifacts` | One row per saved version (`id`, `session_id`, `name`, `version`, `mime_type`, `size`, `content_hash`, `blob_ready`, `repair_attempts`, `expires_at`, `tags`, `created_at`) |
| `artifact_shares` | ACL grants: `(artifact_id, granted_to_session_id, granted_by, granted_at)` |
| `pending_blob_puts` | Intent journal for in-flight saves (`intent_id`, `hash`, `artifact_id`, `created_at`) — powers crash recovery |
| `pending_blob_deletes` | Tombstone queue for orphaned blobs (`hash`, `enqueued_at`, `claimed_at`) — `claimed_at` is the Phase B drain claim stamp (Plan 3); Plan 4 moves the drain to a background worker |
| `meta` | Key/value: currently holds `store_id` (UUID paired with blob-backend sentinel) |

### Blob storage

Content is stored by SHA-256 hash via `@koi/blob-cas`. The blob directory also holds a single `.store-id` sentinel file with the same UUID as the `meta.store_id` row — mismatched UUIDs cause `createArtifactStore` to refuse to open.

## Save protocol (crash-safe)

The save flow is designed so no crash leaves invisible committed state:

```
1. validate input              (invalid_input fast-fail)
2. hash content (SHA-256)
3. INSERT INTO pending_blob_puts (intent_id, hash, NULL)
4. blobStore.put(hash, bytes)  (OUTSIDE DB transaction; may stream large bytes)
5. BEGIN IMMEDIATE
6. INSERT INTO artifacts (blob_ready=0)
7. UPDATE pending_blob_puts SET artifact_id = ?
8. COMMIT
9. verify blobStore.has(hash)  (positive-has gate before publishing)
10. UPDATE artifacts SET blob_ready = 1
11. DELETE FROM pending_blob_puts WHERE intent_id = ?
```

If the process crashes between any two steps, startup recovery (below) reconciles the intent against the row state.

## Startup recovery

Run synchronously during `createArtifactStore`. Walks `pending_blob_puts` by `created_at`, then sweeps any orphaned `blob_ready=0` rows.

| Row state | Action |
|---|---|
| `artifact_id` NULL (crashed before INSERT) | retire intent; tombstone hash if unreferenced |
| `artifact_id` set, row missing (externally deleted) | retire intent; tombstone hash if unreferenced |
| `artifact_id` set, `blob_ready=1` | retire intent (update was committed, retirement was lost) |
| `artifact_id` set, `blob_ready=0`, blob present | promote to `blob_ready=1`, retire intent |
| `artifact_id` set, `blob_ready=0`, blob absent | increment `repair_attempts`; terminal-delete only at `maxRepairAttempts` (default 10) |

A single negative `blobStore.has()` probe never reaps a committed save — this tolerates transient backend outages across restarts. Only persistent missing-blob across N consecutive startup attempts triggers terminal loss.

## Lifecycle

**Policy shape.** `ArtifactStoreConfig.policy?: LifecyclePolicy` carries three optional knobs: `ttlMs` (rows expire N milliseconds after save), `maxSessionBytes` (per-session byte quota enforced at save time AND reclaimed oldest-first at sweep time), and `maxVersionsPerName` (retain only the N most-recent versions of a `(sessionId, name)` tuple — older ones are swept). Each field must be a finite positive integer when present; `validateLifecyclePolicy` throws at `createArtifactStore` rather than at save time so misconfiguration surfaces on boot. TTL uses **freeze-at-save** semantics: `artifacts.expires_at` is stamped from `createdAt + ttlMs` at save time and never recomputed. Changing `ttlMs` after rows are persisted does not resurrect expired rows or re-stamp live ones — the frozen value is the truth. Rows with `expires_at = NULL` (saved under a policy without TTL) never expire even if a later policy adds `ttlMs`.

**Sweep protocol.** `sweepArtifacts()` is two-phase. **Phase A** opens a single `BEGIN IMMEDIATE` transaction, computes the deletion set across all three policy dimensions over `blob_ready = 1` rows only (in-flight saves belong to startup recovery), deletes the rows (`ON DELETE CASCADE` drops share grants), and tombstones any `content_hash` whose only live references sat inside the deletion set — all in the same transaction to preclude TOCTOU against concurrent saves and re-saves of the same content. **Phase B** drains `pending_blob_deletes` via three tiny transactions per tombstone (claim → blob delete → reconcile) with blob I/O running outside every SQLite lock so a slow or remote backend cannot block saves. The claim predicate (`NOT EXISTS artifacts AND NOT EXISTS pending_blob_puts`) rejects any hash that was reclaimed by a save between Phase A commit and claim; `resume-from-claimed` handles crashes between claim and reconcile. Until Plan 4 moves Phase B to a background worker, `sweepArtifacts()` runs both phases sequentially so a single call leaves the store clean. The full race analysis — save-reclaims-tombstone, pending_blob_puts protection, terminal-lost-blob conditions — lives in spec §6.3 (`docs/superpowers/specs/2026-04-18-artifacts-design.md`).

**Scavenger.** `scavengeOrphanBlobs()` is disaster recovery only, not a hot path. If SQLite is truncated or restored from an older backup, tombstones can be lost while orphaned bytes linger on the CAS backend; the scavenger snapshots the union of `artifacts.content_hash ∪ pending_blob_deletes.hash ∪ pending_blob_puts.hash` inside one `BEGIN IMMEDIATE`, walks `blobStore.list()` outside every DB lock (O(N) over the backend — S3 pagination, large filesystem walks), journals every unreferenced hash into `pending_blob_deletes`, and delegates to Phase B. It **never deletes blobs directly** — every reclamation flows through the same claim/delete/reconcile protocol sweep uses, so save-reclaims-tombstone and pending_blob_puts protection apply unchanged and the scavenger is safe to run concurrently with saves and sweeps. `bytesReclaimed` is 0 in Plan 3 because `BlobStore.list()` yields only hashes and re-reading each deleted blob just to measure size would double every pass's I/O on an S3 backend; operators who need exact accounting can diff `du` before and after.

## Single-writer lock

Advisory lock acquired at `createArtifactStore` via atomic tmp-file + `linkSync` publish on both the DB path (`<dbPath>.lock`) and the blob directory (`<blobDir>/.writer-lock`). Lock file contents are `<pid>:<uuid>` — the UUID owner token defends against PID reuse.

Second-open on either side throws `already open by another process`. On clean shutdown, `close()` unlinks both lock files. On process death, the next open verifies the PID is no longer live before stealing the lock.

## ACL and probe-resistance

Three visibility paths:

1. **Owner** — `sessionId === artifact.session_id` → full access.
2. **Shared** — row in `artifact_shares` for `(artifact_id, session_id)` → read access.
3. **Other** — always surfaced as `not_found`, never `forbidden`. The outcome is indistinguishable from a nonexistent id.

`listArtifacts` filters by the caller's session and (by default) includes shared-in artifacts. `shareArtifact` / `revokeShare` require the caller to be the owner.

## Configuration

```ts
interface ArtifactStoreConfig {
  readonly dbPath: string;              // SQLite file path; ':memory:' and 'file:*?mode=memory' supported
  readonly blobDir: string;             // Filesystem dir for CAS
  readonly durability?: "process" | "os"; // journal_mode tuning
  readonly maxArtifactBytes?: number;   // Upper bound per save (invalid_input above)
  readonly maxRepairAttempts?: number;  // Default 10 — see Startup recovery
  readonly policy?: LifecyclePolicy;    // See Lifecycle — validated at construction
}

interface LifecyclePolicy {
  readonly ttlMs?: number;              // Frozen onto expires_at at save time
  readonly maxSessionBytes?: number;    // Per-session quota; rejected at save AND swept oldest-first
  readonly maxVersionsPerName?: number; // Retain N newest versions per (sessionId, name)
}
```

All `LifecyclePolicy` fields are optional and each must be a finite positive integer when present; omitted fields disable the corresponding rule. Plan 5 (#1922) will add `blobStore` for pluggable backends.

## L3 wiring

`@koi/runtime` exposes an `artifacts: { store, sessionId }` config that produces a ComponentProvider attaching four agent-facing tools: `artifact_save`, `artifact_get`, `artifact_list`, `artifact_delete`. The TUI (`koi tui`) opens a per-process store at `~/.koi/artifacts/` and binds calls to the active TUI session. Advisory-lock contention (concurrent TUIs) logs to stderr and disables artifact tools for the second process rather than aborting the session.

## Testing

- Unit: 157 tests in `packages/lib/artifacts/src/__tests__/` covering CRUD, ACL, validation, lock, migration, recovery, concurrent-save edge cases, and (Plan 3) policy validation, quota accounting, Phase A sweep across TTL/quota/retention, Phase B drain (claim/delete/reconcile + resume-from-claimed), save-side tombstone reclaim, and scavenger orphan detection.
- Integration: 5 standalone Golden tests + 1 ATIF trajectory-replay test in `packages/meta/runtime/src/__tests__/golden-replay.test.ts` (cassette: `fixtures/artifacts-roundtrip.trajectory.json`).
- TUI corner cases (manual): concurrent-TUI degradation, bogus-id not_found, list filters, delete-then-get.
