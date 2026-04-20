# @koi/artifacts

Versioned, session-scoped file lifecycle for agent-created outputs. Metadata in SQLite, bytes in a content-addressed blob store (`@koi/blob-cas`), single-writer advisory lock, crash-safe save protocol.

This is Plan 2 of issue #1651. Plan 3 (#1920) added TTL + quota lifecycle — see [Lifecycle](#lifecycle). Plan 4 (#1921) moved blob-ready repair and Phase B tombstone drain off the open path onto a background worker — see [Startup recovery + background worker](#startup-recovery--background-worker). Plan 5 (#1922) added pluggable blob backends via `ArtifactStoreConfig.blobStore` — see [Pluggable blob backends](#pluggable-blob-backends) and [Backend selection](#backend-selection). Plan 6 (#1923) finalized backend selection guidance and L3 roll-ups.

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

Run synchronously during `createArtifactStore`. Local-only: the open path touches SQLite exclusively — zero blob I/O on the critical path (Plan 4, spec §6.5). Walks `pending_blob_puts` and converts any row older than `staleIntentGraceMs` into a `pending_blob_deletes` tombstone (`artifact_id` NULL) or retires it (`artifact_id` set, row missing / `blob_ready=1`) in one `BEGIN IMMEDIATE`. Fresh rows (within the grace window) are left alone because a concurrent save in another process may still be mid-flight. All `has()` / `delete()` probes against the blob backend — promoting `blob_ready=0` rows, terminally deleting after `maxRepairAttempts`, draining tombstones — happen later on the background worker.

A single negative `blobStore.has()` probe never reaps a committed save — this tolerates transient backend outages across restarts. Only persistent missing-blob across N consecutive worker probes triggers terminal loss (see below).

## Startup recovery + background worker

**Open is local-only.** `createArtifactStore` performs the stale-intent drain inside SQLite and returns — no `blobStore.has()`, no `blobStore.delete()`, no network calls on the critical path. This makes open latency constant regardless of the blob backend's health (S3 hiccups can no longer block store construction). The `staleIntentGraceMs` default of 5 minutes is a safety bound: it must exceed worst-case save latency so a real in-flight save (another process, a slow CAS backend, a large payload) is never mistaken for stale and tombstoned out from under its owner. Tests may lower it to 0 for deterministic drains, but production values should stay well above typical blob-write P99.

**Open sweep is TTL-only.** If the store was configured with `policy.ttlMs`, open runs a `blob_ready = 1` TTL-only reap — no quota, no retention. Quota and retention depend on session-scoped accounting that the background worker and explicit `sweepArtifacts()` handle authoritatively; replaying them inline on open would duplicate work, risk BEGIN IMMEDIATE contention with the worker's first tick, and couple open latency to policy size. TTL alone is cheap (indexed `expires_at` scan) and addresses the only time-sensitive policy — stale bytes that expired while the process was down.

**Background worker.** `workerIntervalMs` (default 30_000, `"manual"` for tests) schedules a `setInterval` that runs one iteration per tick: first `drainBlobReadyZero` (promote ready rows, increment `repair_attempts` on misses, terminal-delete at `maxRepairAttempts`), then the Phase B tombstone drain (claim → `blobStore.delete()` → reconcile). `"manual"` disables the interval entirely so tests drive `runOnce()` deterministically; the 100ms floor on numeric values guards against pathological busy loops that would starve save/get transactions.

**`repair_attempts` semantics.** Only **confirmed-absent** probes count — a `blobStore.has()` that returns `false` cleanly. Transient failures (a thrown `has()` call, network error, 5xx) are logged via `onEvent` as `transient_repair_error` but do not advance the counter. This preserves the Plan 2 invariant that N consecutive clean absence probes — not N flaky iterations — are required before terminal loss.

**`onEvent` hook shape.** `onEvent?: (event: ArtifactStoreEvent) => void` fires on two kinds: `repair_exhausted` (terminal delete after `maxRepairAttempts` — stable fields: `artifactId`, `contentHash`, `sessionId`, `attempts`) and `transient_repair_error` (raw backend error surfaced to the operator — fields: `artifactId`, `contentHash`, `error: unknown`). A thrown callback is swallowed with a one-shot `console.warn` so a bad observer cannot corrupt repair progress. Typical operator use: log `repair_exhausted` to an alerting channel (a steady stream implies systemic blob-write loss, not a blip) and feed `transient_repair_error` rates into a backend-health dashboard.

**Close barrier.** `close()` stops the interval, then awaits the in-flight iteration (if any) before unlinking the advisory lock. Callers that want a synchronous flush — `await store.close()` at shutdown — are guaranteed no worker tick is racing the lock release.

See spec §6.5 (`docs/superpowers/specs/2026-04-18-artifacts-design.md`) for the full race analysis (stale-intent grace window, save-reclaims-tombstone, `repair_attempts` monotonicity under concurrent processes, worker vs. manual-sweep overlap).

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
  readonly dbPath: string;                      // SQLite file path; ':memory:' and 'file:*?mode=memory' supported
  readonly blobDir: string;                     // Filesystem dir for CAS
  readonly durability?: "process" | "os";       // journal_mode tuning
  readonly maxArtifactBytes?: number;           // Upper bound per save (invalid_input above)
  readonly maxRepairAttempts?: number;          // Default 10 — see Startup recovery
  readonly staleIntentGraceMs?: number;         // Default 300_000 (5 min) — stale-intent drain safety bound
  readonly workerIntervalMs?: number | "manual"; // Default 30_000; "manual" disables the interval (tests)
  readonly onEvent?: (event: ArtifactStoreEvent) => void; // Drift signal (repair_exhausted / transient_repair_error)
  readonly policy?: LifecyclePolicy;            // See Lifecycle — validated at construction
  readonly blobStore?: BlobStore;               // Plan 5: inject a pre-built backend (e.g. @koi/artifacts-s3). Omitted → filesystem CAS at blobDir
}

interface LifecyclePolicy {
  readonly ttlMs?: number;              // Frozen onto expires_at at save time
  readonly maxSessionBytes?: number;    // Per-session quota; rejected at save AND swept oldest-first
  readonly maxVersionsPerName?: number; // Retain N newest versions per (sessionId, name)
}
```

All `LifecyclePolicy` fields are optional and each must be a finite positive integer when present; omitted fields disable the corresponding rule.

## Pluggable blob backends

`ArtifactStoreConfig.blobStore?: BlobStore` accepts a pre-built blob store from any implementation conforming to the `@koi/blob-cas` `BlobStore` contract (Plan 5). Omitted → the default filesystem CAS at `blobDir` is created automatically. Provided → the filesystem CAS is skipped and the injected backend is used directly for every put/get/has/delete/list and the store-id sentinel. All save-protocol invariants (crash recovery, positive-has gate, repair worker, Phase B tombstone drain, scavenger) run unchanged over whichever backend is wired. The pairing fingerprint (`meta.store_id` ↔ backend sentinel) stays the authority for backend identity, so the injected backend and SQLite DB are still refused if they come from different stores.

`@koi/artifacts-s3` ships the first alternate backend (AWS S3 and S3-compatible stores — MinIO, Cloudflare R2, Backblaze B2). Full config surface, security model (explicit credentials, no env-var fallback), key layout, and cost notes live in [`docs/L2/artifacts-s3.md`](./artifacts-s3.md).

## Backend selection

Pick the backend that matches your deployment shape — semantics are identical, cost and operational characteristics are not.

**Use filesystem (`createFilesystemBlobStore`, the default when `blobStore` is omitted)** for single-process hosts, local development, the `koi tui` default at `~/.koi/artifacts/`, and any deployment where artifact bytes do not need to outlive the host machine. Every put/has/delete is a local syscall — O(µs) — so sweeps and scavenges that touch thousands of blobs stay cheap. No network dependency, no credentials to rotate.

**Use S3 (`createS3BlobStore` from `@koi/artifacts-s3`)** for multi-host fleets that need a shared blob layer, or when artifact retention must outlive the host lifetime (containers that scale to zero, ephemeral CI workers, cross-region DR). Trade-off: every put/has/delete is an HTTPS round-trip — O(tens of ms) — so bulk operations are noticeably slower than the filesystem backend and scavenger `list()` pages over the bucket. Single-artifact save/get latency is dominated by the hash + DB transaction, so it barely moves; Phase B drains and scavenges scale linearly with round-trip cost.

**Delete cost (S3 only).** `delete(h)` issues `HeadObject` + `DeleteObject` so the backend can return `true` / `false` exactly like the filesystem CAS (S3's `DeleteObject` is idempotent and can't distinguish missing-vs-present in-band). Every Phase B tombstone delete is ~2 round-trips. On the save/get hot path this never fires; only the background worker's tombstone drain, terminal-delete branch, and scavenger pay it.

**Security (S3 only).** Per spec §8, `createS3BlobStore` requires `region`, `bucket`, and `credentials` explicitly — it **never** reads AWS env vars or the SDK's default credential chain. Operators thread credentials from a vetted source (secret manager, sealed config, IAM role exchange). This rules out the failure mode where a misconfigured deployment silently picks up stale developer credentials.

**Read-after-write.** Both backends satisfy the `BlobStore` contract. The filesystem CAS fsyncs the blob before `put` resolves; S3 has offered strong read-after-write consistency globally since December 2020 (same for MinIO, R2, B2). The positive-has gate (step 9 of the save protocol) is safe on either — no retry loop needed.

## L3 wiring

`@koi/runtime` exposes an `artifacts: { store, sessionId }` config that produces a ComponentProvider attaching four agent-facing tools: `artifact_save`, `artifact_get`, `artifact_list`, `artifact_delete`. The TUI (`koi tui`) opens a per-process store at `~/.koi/artifacts/` and binds calls to the active TUI session. Advisory-lock contention (concurrent TUIs) logs to stderr and disables artifact tools for the second process rather than aborting the session.

## Testing

- Unit: 218 tests in `packages/lib/artifacts/src/__tests__/` covering CRUD, ACL, validation, lock, migration, recovery, concurrent-save edge cases, (Plan 3) policy validation, quota accounting, Phase A sweep across TTL/quota/retention, Phase B drain (claim/delete/reconcile + resume-from-claimed), save-side tombstone reclaim, scavenger orphan detection, and (Plan 4) stale-intent grace-window drain, local-only open path, TTL-only open sweep, `drainBlobReadyZero` repair probes, background worker scaffolding (start/stop/runOnce), close-barrier iteration flush, and structured `onEvent` drift signals.
- Integration: 5 standalone Golden tests + 1 ATIF trajectory-replay test in `packages/meta/runtime/src/__tests__/golden-replay.test.ts` (cassette: `fixtures/artifacts-roundtrip.trajectory.json`).
- TUI corner cases (manual): concurrent-TUI degradation, bogus-id not_found, list filters, delete-then-get.
