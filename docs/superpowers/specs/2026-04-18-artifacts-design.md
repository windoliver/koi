# `@koi/artifacts` — Versioned File Lifecycle for Agent-Created Outputs

**Issue:** [#1651](https://github.com/windoliver/koi/issues/1651) — v2 Phase 3
**Date:** 2026-04-18
**Status:** Design approved; ready for implementation plan

---

## 1. Problem

Today, agent-generated files land on disk with no tracking. Users lose track of which files belong to which session. Browser-using and image-generating agents produce large artifacts with no lifecycle management. There is no way to reference an artifact from another session ("show me the diagram from yesterday").

We need a dedicated L2 package that tracks files created by agents — images, documents, code, screenshots, binaries — with versioning, lifecycle (TTL + quota), access control, and pluggable storage backends.

## 2. Scope

Full scope shipped in this PR:

- CRUD: `saveArtifact`, `getArtifact`, `listArtifacts`, `deleteArtifact`
- Versioning: save with same `(sessionId, name)` → new monotonic version; content-hash dedup at blob layer
- Lifecycle: TTL + per-session byte quota + per-name version retention. **TTL is a visibility guarantee** (expired rows are never surfaced to readers) plus best-effort physical reclamation via (a) opportunistic save-path cleanup, (b) owner delete-on-expired, and (c) explicit `sweepArtifacts`. Applications needing hard wall-clock bounded retention should schedule `sweepArtifacts` on a timer — the `ArtifactStore` itself does not start background work. Recovery-on-open also runs one sweep pass (§6.5) so that stored expired data does not outlive a process restart.
- Backends: local filesystem default (`@koi/artifacts`); S3 as optional sub-package (`@koi/artifacts-s3`)
- Access control: session-scoped default; explicit `shareArtifact(artifactId, withSessionId)` for cross-session reads; deny-closed
- Integration: SessionId referenced via branded type from `@koi/core`

**Out of scope (deferred):**
- Agent-facing tools (`save_artifact` builtin) — follow-up PR layered on the stable `ArtifactStore` contract
- Auto-capture middleware that intercepts file-write tools — follow-up PR
- Streaming save/get — defer until a concrete consumer (browser screenshots) demands it
- GCS / Azure Blob backends — same shape as S3, additive

## 3. Architecture

### 3.0 Concurrency contract

**Single-writer per store — actively enforced via a lock file AND a store-id fingerprint.** An `ArtifactStore` is identified by the pairing of its metadata DB and its blob backend; the two must never be mixed across different stores.

Enforcement has two layers:

**Layer 1 — single live writer per DB (advisory lock).**
- If `dbPath === ":memory:"` or the SQLite in-memory URI form, the lock step is skipped — each `:memory:` DB is process-local and isolated by SQLite.
- Otherwise, `createArtifactStore` acquires an exclusive advisory lock on `<dbPath>.lock` via `flock(LOCK_EX | LOCK_NB)` (POSIX) or equivalent. If not immediately acquirable → throw `Error("ArtifactStore already open by another process")`.
- Released by `close()` or kernel on process death; stale lock files do not strand new owners.

**Layer 2 — metadata DB ↔ blob backend pairing (store-id fingerprint).**
- On every `createArtifactStore`, read the DB's `meta.store_id` row and the blob backend's sentinel — FS: `<blobDir>/.store-id`; S3: a well-known key like `__store_id__` at the bucket/prefix root.

| DB `store_id` | Blob sentinel | Action |
|---------------|----------------|--------|
| present       | present + matches       | open normally |
| present       | present + differs       | throw `"Blob backend is paired with a different ArtifactStore"` |
| present       | missing                 | throw `"Blob backend is missing store-id sentinel; operator must restore or reset explicitly"` |
| missing       | present                 | throw `"Metadata DB is missing store-id; operator must restore or reset explicitly"` |
| missing       | missing + blob backend provably empty AND DB has zero rows in `artifacts`, `pending_blob_puts`, `pending_blob_deletes` | generate fresh UUID, write both sentinels, open. This is the bootstrap-new-store path. |
| missing       | missing + either side has existing data | throw `"Store-id missing on a non-empty store; operator must restore or reset explicitly"` |

- Bootstrap is only permitted when both sides are provably empty. One-sided missing fingerprints or any non-empty state with a missing sentinel are operator-repair conditions, not silent auto-heal paths. This prevents the class of failures where a restored DB or wiped sentinel silently re-pairs with the wrong blob set.
- `:memory:` DBs generate a fresh `store_id` on each open; pairing with a pre-existing FS blob backend will therefore fail (sentinel present, DB's fresh `store_id` differs). Test harnesses must use a fresh `blobDir` per `:memory:` DB — matching the common pattern of `tmpdir()`-based per-test isolation.

Together: layer 1 prevents two processes from racing on the same DB; layer 2 prevents mis-paired metadata/blob configurations. Startup recovery is sound — we are provably the only owner *and* the blob backend belongs to our metadata.

Multiple reader processes are permitted (WAL allows concurrent readers); read-only use cases are out of scope for the writer lock.

### 3.1 Package layout

Three new packages + one refactor:

```
packages/lib/
  blob-cas/             NEW   L0u utility — content-addressed blob store
                              (extracted from packages/lib/checkpoint/src/cas-store.ts)
  checkpoint/           MODIFIED — re-exports CAS from @koi/blob-cas; public API unchanged
  blob-cas/             (continued) ← owns BlobStore interface + FS implementation + contract-test helper
  artifacts/            NEW   L2 — metadata store + orchestration; consumes BlobStore from @koi/blob-cas
  artifacts-s3/         NEW   L2 — S3 BlobStore implementation (independent of @koi/artifacts)
```

### 3.2 Layer compliance

| Package             | Layer | Deps                                     |
|---------------------|-------|------------------------------------------|
| `@koi/blob-cas`     | L0u   | `@koi/core`                              |
| `@koi/checkpoint`   | L2    | `@koi/core`, `@koi/blob-cas` (added)     |
| `@koi/artifacts`    | L2    | `@koi/core`, `@koi/blob-cas`             |
| `@koi/artifacts-s3` | L2    | `@koi/core`, `@koi/blob-cas`             |

All new packages import from L0/L0u only — no peer-L2 or L1 deps. Layering is enforced by `bun run check:layers`.

The `BlobStore` interface (§4) and the `runBlobStoreContract` test helper (§9.4) live in `@koi/blob-cas`, not `@koi/artifacts`. This keeps `@koi/artifacts-s3` as an independent L2 backend that composes with `@koi/artifacts` at the consumer (runtime) layer — the runtime wires both and passes the S3 store as `ArtifactStoreConfig.blobStore`.

### 3.3 Rationale for Approach 3 (extract CAS)

`@koi/snapshot-store-sqlite` is reused by 6+ feature packages as a shared storage adapter — this is the dominant v2 pattern. `@koi/checkpoint` happens to export CAS publicly, but depending on it from `@koi/artifacts` semantically conflates a feature package with a utility. Extracting CAS to `@koi/blob-cas` matches the established pattern (small shared adapters composed into feature packages) and keeps `@koi/checkpoint` focused on its feature.

Cost: a file-move refactor of `@koi/checkpoint`. Checkpoint's public exports are preserved via re-export; all existing checkpoint tests pass unchanged.

## 4. Public API

Location: `@koi/core` gains `ArtifactId` branded type; `@koi/artifacts` exports the rest.

```ts
// @koi/core
export type ArtifactId = Brand<string, "ArtifactId">;
export const artifactId: (id: string) => ArtifactId;

// @koi/artifacts
export interface Artifact {
  readonly id: ArtifactId;
  readonly sessionId: SessionId;
  readonly name: string;
  readonly version: number;
  readonly mimeType: string;
  readonly size: number;
  readonly contentHash: string;   // sha256 hex
  readonly createdAt: number;     // Unix ms
  readonly tags: ReadonlyArray<string>;
}

export interface SaveArtifactInput {
  readonly sessionId: SessionId;
  readonly name: string;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly tags?: ReadonlyArray<string>;
}

export interface ArtifactFilter {
  // Caller context is passed separately as `ctx`. The filter narrows within
  // the set the caller is already authorized to see; it cannot widen it.
  readonly name?: string;                    // exact match; lists all versions
  readonly tags?: ReadonlyArray<string>;     // AND semantics
  readonly includeShared?: boolean;          // default false; include artifacts shared TO ctx.sessionId
}

export interface LifecyclePolicy {
  readonly ttlMs?: number;
  readonly maxSessionBytes?: number;
  readonly maxVersionsPerName?: number;
}

export type ArtifactError =
  | { readonly kind: "not_found"; readonly id: ArtifactId }
  | { readonly kind: "quota_exceeded"; readonly sessionId: SessionId; readonly usedBytes: number; readonly limitBytes: number }
  | { readonly kind: "invalid_input"; readonly field: string; readonly reason: string };

// Note: there is no public `forbidden` kind. Non-owner access to an artifact
// always surfaces as `not_found` on the wire (probe-resistance). Forbidden is
// a distinct *internal* concept used for structured logging — never returned.

export interface ArtifactStore {
  saveArtifact(input: SaveArtifactInput): Promise<Result<Artifact, ArtifactError>>;
  getArtifact(id: ArtifactId, ctx: { sessionId: SessionId }): Promise<Result<{ meta: Artifact; data: Uint8Array }, ArtifactError>>;
  listArtifacts(filter: ArtifactFilter, ctx: { sessionId: SessionId }): Promise<ReadonlyArray<Artifact>>;
  deleteArtifact(id: ArtifactId, ctx: { sessionId: SessionId }): Promise<Result<void, ArtifactError>>;
  shareArtifact(id: ArtifactId, withSessionId: SessionId, ctx: { ownerSessionId: SessionId }): Promise<Result<void, ArtifactError>>;
  revokeShare(id: ArtifactId, fromSessionId: SessionId, ctx: { ownerSessionId: SessionId }): Promise<Result<void, ArtifactError>>;
  // Applies the SAME policy configured on the store (ArtifactStoreConfig.policy).
  // No per-call override — retention is a single source of truth, so reads and
  // sweep can never disagree about whether a row is reclaimable.
  sweepArtifacts(): Promise<{ deleted: number; bytesReclaimed: number }>;
  scavengeOrphanBlobs(): Promise<{ deleted: number; bytesReclaimed: number }>;  // disaster-recovery only

  // Close the store — a full store-wide barrier over EVERY public API. Strict ordering:
  //   1. Flip `closing = true`. Every API (`saveArtifact`, `deleteArtifact`,
  //      `shareArtifact`, `revokeShare`, `sweepArtifacts`, `scavengeOrphanBlobs`,
  //      `getArtifact`, `listArtifacts`) checks `closing` at entry and rejects new calls.
  //      In-flight calls continue.
  //   2. Signal the background repair/Phase B worker to stop scheduling new iterations.
  //   3. **Await every in-flight operation.** The store tracks a counter of active
  //      operations: all public API calls (both read and write) AND background worker
  //      iterations, including any in-flight `blobStore.get`/`has`/`put`/`delete`.
  //      `close()` awaits the counter reaching zero with **no internal timeout**: if any
  //      I/O is stuck, `close()` blocks. A stuck close is preferable to releasing
  //      ownership while reads or destructive I/O are still in flight — that would
  //      throw SQLite/blob-close errors into a reader mid-fetch or race a new owner.
  //   4. Close SQLite; close the BlobStore if owned.
  //   5. Release the single-writer lock (§3.0).
  //
  // Guarantee: after `close()` resolves, no further SQLite or blob-store activity will
  // occur on behalf of this store (neither reads nor writes). A later
  // `createArtifactStore` on the same dbPath cannot race the old owner.
  //
  // After close() resolves, every method throws `"ArtifactStore is closed"`. Idempotent.
  //
  // Operators whose shutdown is genuinely stuck on a frozen backend must kill the process
  // (kernel-releases the advisory lock); the new owner then runs recovery.
  close(): Promise<void>;
}

export interface ArtifactStoreConfig {
  readonly dbPath: string;                     // SQLite file; ":memory:" for tests
  readonly blobDir: string;                    // CAS directory (used by default FS backend)
  readonly blobStore?: BlobStore;              // override (e.g., S3)
  readonly policy?: LifecyclePolicy;           // applied on save + sweepArtifacts
  readonly durability?: "process" | "os";      // matches snapshot-store pattern
  readonly maxArtifactBytes?: number;          // validation cap; default 100 MiB
  readonly maxRepairAttempts?: number;         // bound retries on blob_ready=0 rows
                                               // before force-resolving them (§6.5 step 4a);
                                               // default 10
}

export function createArtifactStore(config: ArtifactStoreConfig): ArtifactStore;

// @koi/blob-cas exports both the interface AND the concrete FS implementation.
// Placing the interface here lets @koi/artifacts-s3 implement it without
// taking a peer-L2 dep on @koi/artifacts.
//
// CONSISTENCY REQUIREMENT (contract, enforced by runBlobStoreContract):
// After `put(h)` resolves, every subsequent `has(h)` / `get(h)` / `list()`
// MUST reflect its presence. After `delete(h)` resolves, every subsequent
// `has(h)` / `get(h)` / `list()` MUST reflect its absence. Read-after-write
// consistency is required; eventually-consistent backends are not supported.
// S3 meets this (strong RAW consistency since Dec 2020). The FS impl meets
// this via the fsync-then-rename sequence in blob-cas.
//
// Save-repair loops, startup recovery, and orphan detection all depend on
// this guarantee — violating it risks silent data loss.
export interface BlobStore {
  put(data: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array | undefined>;
  has(hash: string): Promise<boolean>;
  delete(hash: string): Promise<boolean>;
  // Enumeration — required for scavengeOrphanBlobs (§6.4).
  // FS impl: directory walk. S3 impl: paginated ListObjectsV2.
  // Yields hashes in unspecified order; must terminate for a non-growing store.
  list(): AsyncIterable<string>;
}

// Concrete FS impl (wraps the CAS primitives — blobPath/hasBlob/writeBlob/readBlob)
export function createFilesystemBlobStore(blobDir: string): BlobStore;
```

## 5. Storage Schema

SQLite with WAL + pragmas matching `packages/lib/snapshot-store-sqlite/src/schema.ts`.

```sql
CREATE TABLE artifacts (
  id              TEXT PRIMARY KEY,             -- art_<uuid>
  session_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         INTEGER NOT NULL,
  mime_type       TEXT NOT NULL,
  size            INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,                -- sha256 hex
  tags            TEXT NOT NULL DEFAULT '[]',   -- JSON array
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,                      -- Unix ms. NULL = no TTL. Computed
                                                -- from policy.ttlMs AT SAVE TIME and
                                                -- frozen on the row — subsequent policy
                                                -- changes cannot resurrect expired rows
                                                -- (prevents cross-policy ACL revival).
  blob_ready      INTEGER NOT NULL DEFAULT 1,   -- 0 = in-flight repair (hidden from readers),
                                                -- 1 = blob guaranteed present at COMMIT time
  repair_attempts INTEGER NOT NULL DEFAULT 0,   -- times the background worker has
                                                -- attempted to resolve this blob_ready=0
                                                -- row; caps at `maxRepairAttempts` (config,
                                                -- default 10) before the row is failed
                                                -- out (§6.5 step 4a)
  UNIQUE(session_id, name, version)
);
CREATE INDEX idx_artifacts_session ON artifacts(session_id);
CREATE INDEX idx_artifacts_name    ON artifacts(session_id, name);
CREATE INDEX idx_artifacts_created ON artifacts(created_at);
CREATE INDEX idx_artifacts_hash    ON artifacts(content_hash);

CREATE TABLE artifact_shares (
  artifact_id           TEXT NOT NULL,
  granted_to_session_id TEXT NOT NULL,
  granted_at            INTEGER NOT NULL,
  PRIMARY KEY(artifact_id, granted_to_session_id),
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX idx_shares_grantee ON artifact_shares(granted_to_session_id);

-- Durable tombstones for orphan blob cleanup. Survives crashes; a sweep
-- restart resumes Phase B from any rows still present here.
-- `claimed_at` is non-null once Phase B commits a claim to delete the blob
-- outside the lock. saveArtifact observes this flag atomically and re-puts
-- the blob after commit if it reclaims a claimed tombstone.
CREATE TABLE pending_blob_deletes (
  hash        TEXT PRIMARY KEY,
  enqueued_at INTEGER NOT NULL,
  claimed_at  INTEGER                  -- NULL until Phase B claim step commits
);
CREATE INDEX idx_pending_enqueued ON pending_blob_deletes(enqueued_at);

-- In-flight save intents. Inserted before blobStore.put(), removed after
-- the artifacts row is inserted. Scavenger treats any hash with a row here
-- as still-live (a save is about to insert metadata for it), preventing
-- the scavenger-vs-save race where scavenger deletes a blob that a save
-- just put but hasn't yet inserted metadata for.
CREATE TABLE pending_blob_puts (
  intent_id   TEXT PRIMARY KEY,        -- uuid per save attempt
  hash        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_pending_puts_hash ON pending_blob_puts(hash);
CREATE INDEX idx_pending_puts_created ON pending_blob_puts(created_at);

-- Key/value table for store identity + schema version.
-- Keys: "store_id" (UUID paired with the blob backend's sentinel, §3.0),
--       "schema_version" (integer, for future migrations).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Content (bytes) lives in the CAS directory managed by the `BlobStore`, keyed by SHA-256 hash. SQLite never holds blob bytes — `content_hash` points into the CAS.

## 6. Data Flow

**Design principle.** Remote blob I/O (`blobStore.put`/`blobStore.delete`) **never** runs while a SQLite write lock is held. Metadata transactions are short and local; blob I/O happens outside, with races closed via the `pending_blob_deletes` tombstone table plus a post-commit verify step.

### 6.1 saveArtifact

1. **Pre-transaction validation** (cheap, fail fast): reject on `name`/`mimeType` shape violations, `data.length > maxArtifactBytes`, or malformed tags. All → `invalid_input`.
2. Stream-hash `input.data` → `hash` (reuse `Bun.CryptoHasher` pattern from `@koi/blob-cas`).
3. **Journal the put intent** (short tx): `INSERT INTO pending_blob_puts(intent_id, hash, created_at) VALUES (?, ?, ?)` where `intent_id = uuid()`. Commit. This marks the hash as "in-flight from a save" so the scavenger (§6.4) won't race-delete the blob between our `put` and our INSERT of `artifacts`.
4. **Blob write — outside the lock.** `blobStore.put(data)`. CAS dedups automatically.
5. `BEGIN IMMEDIATE` transaction (metadata only — no network calls inside). **The intent row is retired inside this transaction on every exit path (idempotent return, quota rollback, fresh insert) so `pending_blob_puts` cannot outlive its save.**
   - **Sequencing** — `SELECT MAX(version) FROM artifacts WHERE session_id = ? AND name = ?` across **all** rows (ready and in-flight). `nextVersion = (maxVersion ?? 0) + 1`.
   - **Idempotency** — `SELECT content_hash, blob_ready, created_at FROM artifacts WHERE session_id = ? AND name = ? ORDER BY version DESC LIMIT 1`.
     - If that row has the same `content_hash` as our `hash` AND `isVisible(row, now)` → `DELETE FROM pending_blob_puts WHERE intent_id = ?`, `COMMIT`, return it. Idempotent path retires the intent.
     - Otherwise → proceed as a fresh save at the next version (covers different hash; same hash but `blob_ready = 0`; same hash but TTL-expired).
   - **Quota admission — enforces all three caps, with durable-row safety:**
     1. `maxVersionsPerName` — count all `blob_ready = 1` + `blob_ready = 0` rows for `(session_id, name)`; if count would exceed cap with our pending insert, eviction is required.
     2. `maxSessionBytes` — usage = sum of sizes across `blob_ready = 0` and `blob_ready = 1` rows for the session (in-flight reserves); if `usage + data.length > cap`, eviction is required.
     3. **Durable-row safety rule.** If eviction is required for either cap AND any `blob_ready = 0` row exists in the relevant scope (the same `session_id` for `maxSessionBytes`; the same `(session_id, name)` for `maxVersionsPerName`), do **not** evict. Return `quota_exceeded` instead. Rationale: evicting durable `blob_ready = 1` rows to make room for a save whose own repair might later fail would permanently lose data (the evicted rows are gone; the new row may never become visible). Waiting until no in-flight rows exist guarantees that eviction only happens when every row in scope is either durable or about to become durable with the save we're admitting.
     4. If no `blob_ready = 0` rows in scope → safe to evict: remove the oldest `blob_ready = 1` rows until under cap, tombstoning their hashes per §6.3 Phase A rules.
     5. If cap still cannot be satisfied (cap too small for this single blob; or scope has only in-flight rows):
        - `DELETE FROM pending_blob_puts WHERE intent_id = ?` (retire intent).
        - If no other reference to `hash` → `INSERT OR IGNORE INTO pending_blob_deletes(hash, enqueued_at) VALUES (?, now)`.
        - `COMMIT`.
        - Return `{ ok: false, error: { kind: "quota_exceeded", ... } }`.

     In-flight (`blob_ready = 0`) rows are never eviction victims. Caller retries of `quota_exceeded` succeed once in-flight saves complete — bounded wait, no permanent data loss from transient repair failures.
   - **Observe tombstone claim and atomically reclaim:** `SELECT claimed_at FROM pending_blob_deletes WHERE hash = ?`; then `DELETE FROM pending_blob_deletes WHERE hash = ?`.
   - Compute `expires_at = policy.ttlMs === undefined ? NULL : (now + policy.ttlMs)` — stamped at save time so later policy changes cannot affect this row.
   - `INSERT INTO artifacts (..., expires_at, blob_ready) VALUES (..., ?, 0)` — **always** `blob_ready = 0`. Reserves its version slot and quota budget; invisible to readers.
   - `DELETE FROM pending_blob_puts WHERE intent_id = ?` — intent retirement on the fresh-insert path; atomic with the artifacts INSERT so scavenger never observes "no intent AND no row" for committed bytes.
6. `COMMIT`.
7. **Durable post-commit repair** — always runs (no fast path). The `blob_ready = 0` row persists in SQLite; if the process crashes here, startup recovery (§6.5) drains it.
   - `blobStore.put(data)` — idempotent CAS put.
   - `blobStore.has(hash)` — required to return true per BlobStore's read-after-write contract (§4). If a concurrent sweep's one-shot `delete` races and wins, `has` returns false; loop: `put` again, `has`. Sweep grants at most one blob-delete per claim (§6.3 resume-from-claimed), so the loop terminates in ≤ 2 iterations.
   - `UPDATE artifacts SET blob_ready = 1 WHERE id = ? AND blob_ready = 0`. If `changes == 0` → the row was reaped by startup recovery or a concurrent operation (should never happen per invariants below, but guards against design drift). Throw with `cause` — save is lost; caller retries.
8. Return new `Artifact` (only after the row is `blob_ready = 1`).

**Invariants:**
- **No lifecycle deletion may reap `blob_ready = 0` rows.** TTL-reclamation (opportunistic + sweep) and quota eviction target only `blob_ready = 1` rows. This protects in-flight saves from being reaped mid-repair regardless of TTL tightness or backend latency.
- **Quota admission reserves budget across both `blob_ready` states.** A row's size and version slot count toward `maxSessionBytes` / `maxVersionsPerName` as soon as it's inserted (even at `blob_ready = 0`). Concurrent saves cannot exceed the cap during a repair window.
- **No reader ever observes a `blob_ready = 0` row.** Read-side APIs that apply the *full* `isVisible(row, now)` predicate: `getArtifact`, `listArtifacts`, `shareArtifact`. Owner-override APIs that apply only `blob_ready = 1` (skipping the TTL half, so owners can act on expired rows): `deleteArtifact`, `revokeShare`. No API ever surfaces or operates on `blob_ready = 0` in-flight rows.
- **`blob_ready` is monotonic `0 → 1`.** Never re-written backward. Startup recovery either promotes `0 → 1` or deletes the row entirely.

Both the idempotency check and the version computation read the latest row **inside `BEGIN IMMEDIATE`**, so no two concurrent writers can observe the same "latest" and produce colliding versions.

### Visibility predicate (used by every read-side API)

A single predicate determines which rows are surfaced to callers:

```sql
-- isVisible(row, now) =
--   row.blob_ready = 1
--   AND (row.expires_at IS NULL OR row.expires_at >= now)
```
(`expires_at` is stamped at save time from `policy.ttlMs` and frozen on the row — store policy changes cannot resurrect rows that were expired under their original policy.)

`getArtifact`, `listArtifacts`, and `shareArtifact` apply this predicate. `deleteArtifact` and `revokeShare` apply only the `blob_ready = 1` half — owners must be able to reclaim expired rows and revoke old share grants explicitly (see "Owner overrides" below). Sharing an already-expired row is `not_found`; listing an expired row is hidden. `sweepArtifacts` + startup recovery sweep + opportunistic save-path reclamation + owner delete/revoke together provide best-effort retention — expired data is reclaimed on the next save, process restart, or explicit sweep call, whichever comes first.

### 6.2 getArtifact

1. `SELECT * FROM artifacts WHERE id = ?`. If row missing OR not `isVisible(row, now)` → `not_found`. (Single predicate covers `blob_ready = 0` in-flight rows AND TTL-expired rows.)
2. **ACL check (first pass):** if `session_id === ctx.sessionId` → owner. Else check `artifact_shares` for a row `(id, ctx.sessionId)`. If no match → `not_found` (probe-resistant; `forbidden` logged but not returned).
3. `blobStore.get(content_hash)` → `data`.
4. **Post-read ACL + visibility recheck** — after reading the blob, re-check authorization and visibility against fresh state before returning bytes. This closes the read-vs-revoke TOCTOU: a `revokeShare` that commits between step 2 and step 3 must not let the grantee see the bytes.
   ```sql
   SELECT 1 FROM artifacts WHERE id = ?
     AND blob_ready = 1
     AND (expires_at IS NULL OR expires_at >= <now>)
     AND (
       session_id = :callerSessionId
       OR EXISTS (SELECT 1 FROM artifact_shares
                   WHERE artifact_id = :id
                     AND granted_to_session_id = :callerSessionId)
     )
   ```
   - If not present (either row removed, expired since step 1, or share revoked since step 2) → return `not_found`. Revocation is now linearizable with reads: any successful `revokeShare` that commits before this recheck prevents data delivery.
   - If still present AND `data` is defined → return `{ meta, data }`.
   - If still present AND `data` is undefined (blob missing while metadata still authorizes access) → operator/corruption problem. Throw with `cause`.

Revocation-consistency guarantee: a call to `revokeShare` that returns `ok: true` before a concurrent `getArtifact`'s step 4 commit will cause that get to return `not_found`. No successful revoke can be "undone" by a racing read.

Step 4 closes the `get` vs `sweep` race: sweep Phase B deletes the blob **after** its metadata row is removed in Phase A, so a get that raced sweep will either see (a) no row / hidden row (step 1 path), (b) both row and blob (common case), or (c) row + missing blob → revalidate → row now gone/hidden → `not_found`. No read ever surfaces corruption from a legitimate concurrent deletion.

Same visibility predicate and ACL/probe-resistance logic applies to `shareArtifact` and `listArtifacts`. Non-owners of a visible row see `not_found`. Callers acting on an in-flight (`blob_ready = 0`) row also see `not_found`.

**Owner overrides for expired rows.** Two owner-only APIs operate on any `blob_ready = 1` row the caller owns, **including TTL-expired ones**:

- `deleteArtifact(id, ctx)` — lets the owner finalize reclamation before sweep runs. Without this, expired artifacts could linger on disk if no sweep is scheduled.
- `revokeShare(id, fromSessionId, ctx)` — lets the owner remove share grants on expired rows. Without this, share rows would persist in `artifact_shares` until sweep CASCADE-removes them, creating a window where the grants are hidden by visibility but recoverable if the row ever becomes visible again (e.g., bug in visibility filter, operator error). An owner must always be able to audit and revoke ACLs regardless of TTL state.

`shareArtifact` does NOT get the same override — granting new access on an already-expired row makes no semantic sense. Non-owners still see `not_found` for expired rows across every API.

**Opportunistic TTL reclamation on save.** Inside `saveArtifact`'s `BEGIN IMMEDIATE` transaction (before quota eviction), run a bounded scan of the caller's session — **only over `blob_ready = 1` rows**, keyed on the per-row frozen `expires_at`:
```sql
DELETE FROM artifacts
 WHERE session_id = ?
   AND blob_ready = 1                    -- never touch in-flight repairs
   AND expires_at IS NOT NULL
   AND expires_at < ?                    -- now
 RETURNING id, content_hash
```
For each returned row with no remaining reference, `INSERT OR IGNORE INTO pending_blob_deletes(...)`. This piggybacks on the save's already-held lock and ensures any session that keeps saving naturally reaps its own expired rows without a separate sweep schedule. Combined with owner delete-on-expired, sessions have two in-band reclamation paths plus explicit `sweepArtifacts` for bulk.

**`deleteArtifact` blob cleanup: deferred.** `deleteArtifact` removes only the metadata row (and its share grants via CASCADE) inside a short `BEGIN IMMEDIATE` transaction. If the deletion leaves a content hash unreferenced (checked against `blob_ready = 1` rows + `blob_ready = 0` rows, so pending repairs still count), the caller also inserts a row into `pending_blob_deletes` **in the same transaction** (atomic). The actual blob unlink is always performed by `sweepArtifacts` Phase B under the tombstone discipline in §6.3 — never eagerly inside `deleteArtifact`. This keeps the delete path simple and avoids the save/delete race the reviewer identified.

### 6.3 sweepArtifacts

`sweepArtifacts()` takes no arguments — it applies the store's configured `policy` (§4 `ArtifactStoreConfig.policy`). This is the *only* retention source; reads use the same policy for visibility, so reads and sweep never disagree. A caller that wants different retention must instantiate a different store with a different config.

Correctness invariant: *a valid `get` must never return a missing blob.* Remote blob I/O never happens while SQLite's write lock is held. Tombstones in `pending_blob_deletes` are the durable journal that makes Phase B crash-recoverable and race-safe.

**Phase A — metadata sweep (single transaction, metadata only):**

1. `BEGIN IMMEDIATE`.
2. Compute deletion set from policy, **scanning only `blob_ready = 1` rows**: TTL-expired rows (`expires_at IS NOT NULL AND expires_at < now` — per-row frozen TTL, not store config), per-session quota excess (oldest first), per-(session,name) retention excess. In-flight (`blob_ready = 0`) rows are never candidates — they belong to the active save's repair window and are reclaimed only by startup recovery (§6.5) if the save crashed. This keeps every lifecycle deletion routed through the tombstone journal while protecting active saves.
3. Collect `candidateHashes` = distinct `content_hash` values about to be deleted whose **only** remaining references are inside the deletion set (i.e., no live row outside this batch points at the same hash).
4. `DELETE` matching rows — `ON DELETE CASCADE` removes share grants.
5. For each `hash` in `candidateHashes`: `INSERT INTO pending_blob_deletes(hash, enqueued_at) VALUES (?, ?) ON CONFLICT DO NOTHING`.
6. `COMMIT`.

After Phase A, orphan reclamation is **durable**: even if the process crashes before Phase B, the next sweep's Phase B resumes from `pending_blob_deletes`.

**Phase B — blob sweep (durable claim, blob I/O outside lock):**

Drive Phase B from `SELECT hash FROM pending_blob_deletes ORDER BY enqueued_at` (resumable across crashes and restarts). For each `hash`:

```
-- Claim step (tiny tx, no blob I/O). Writes durable `claimed_at`.
BEGIN IMMEDIATE
  affected = UPDATE pending_blob_deletes
                SET claimed_at = <now>
              WHERE hash = ?
                AND claimed_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)
                AND NOT EXISTS (SELECT 1 FROM pending_blob_puts WHERE hash = ?)
  if affected == 0:
    -- Either: (a) tombstone already gone because a concurrent saveArtifact
    --   reclaimed it (§6.1 step 5) — blob must stay and that save will repair
    --   any missing blob via step 7 unconditional put; OR
    -- (b) a live artifacts row references this hash — blob must stay; OR
    -- (c) an in-flight save has journaled an intent in pending_blob_puts
    --   (put completed but INSERT not yet) — blob must stay.
    -- Clean up any tombstone that is no longer orphan:
    DELETE FROM pending_blob_deletes
          WHERE hash = ?
            AND (EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)
              OR EXISTS (SELECT 1 FROM pending_blob_puts WHERE hash = ?))
    COMMIT
    continue
COMMIT  -- claimed_at is now durable; any concurrent save will observe it

-- Blob I/O step (NO SQLite lock held, safe to block on network).
blobStore.delete(hash)
  -- If delete fails/times out, the tombstone with claimed_at remains; a
  -- later sweep resumes (see "resume-from-claimed" rule below).
  -- FS impl: ENOENT = success. S3 impl: 404 = success. Idempotent.

-- Reconcile step (tiny tx).
BEGIN IMMEDIATE
  changes = DELETE FROM pending_blob_deletes WHERE hash = ?
  -- changes == 0 means a concurrent saveArtifact reclaimed the tombstone
  -- between our claim commit and now. That save observed claimed_at != NULL,
  -- flipped needsRePut = true, and will unconditionally `put` the bytes
  -- after its own COMMIT. Correctness preserved — the save's post-commit put
  -- runs strictly after we released the claim lock, so it either sees a
  -- still-present blob (CAS no-op) or re-writes it.
COMMIT
```

**Resume-from-claimed rule.** If a sweep restarts and sees a row with `claimed_at IS NOT NULL`, it means an earlier Phase B crashed between claim and reconcile. Resume: attempt `blobStore.delete(hash)` (idempotent), then delete the tombstone. The claim is already durable, so no new save can have observed an unclaimed tombstone and skipped its `needsRePut` path — this is safe on crash recovery.

**Why this is safe** (race analysis):

| Interleaving                                                         | Outcome                                                                                    |
|----------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| Claim tombstone → delete blob → reconcile (no save interleaves)       | Blob deleted cleanly. Normal path.                                                         |
| Claim → save reclaims tombstone + puts row → reconcile finds 0 rows  | Blob was deleted by sweep, save's step 6 `has()` returns false, save re-puts bytes. Safe. |
| Save puts bytes (step 3) → save reclaims tombstone (step 4) → claim  | Claim step finds tombstone gone or ref row present; skips blob delete. Safe.               |
| Phase A crash                                                         | No tombstones were written. Live metadata still points at blobs. Safe (§6.4 scavenger).    |
| Crash between Phase A and Phase B                                     | Tombstones survive. Next sweep resumes Phase B. Safe.                                      |
| Crash inside Phase B claim step                                      | Tombstone still present. Next sweep retries.                                                |
| Crash after blob delete, before reconcile                             | Tombstone still present, blob already gone. Next Phase B retry: claim succeeds (no ref), blob delete is idempotent-404, reconcile removes tombstone. Safe. |

**Properties:**
- No SQLite write lock is held across remote blob I/O.
- Tombstone table caps sweep memory — Phase B can pause mid-sweep and resume.
- Phase B is fully idempotent; safe to run concurrently with saves and gets.
- Non-owner deletes, lifecycle evictions, and explicit user deletes all funnel through the same tombstone protocol — one code path, one set of invariants.

### 6.4 Scavenger (catastrophic orphan recovery)

`pending_blob_deletes` is the normal path for reclaiming orphan blobs. If the database itself is truncated or replaced (disaster recovery, restore-from-backup), tombstones can be lost while blobs linger. `scavengeOrphanBlobs()` rebuilds the tombstone journal from the backing store, then reuses the normal Phase B protocol — **it does not delete blobs directly**. This keeps all orphan reclamation under one race-safe discipline.

Flow:

```
-- Live-hash set includes artifacts + pending deletes + pending PUTS. The
-- pending_blob_puts clause is critical: a save that has put the blob but
-- not yet INSERTed metadata appears in pending_blob_puts and is considered
-- live here.
pass1_live = snapshot of {
  SELECT DISTINCT content_hash FROM artifacts
  UNION SELECT hash FROM pending_blob_deletes
  UNION SELECT hash FROM pending_blob_puts
}

candidates = []
for await (hash of blobStore.list()):
  if hash in pass1_live: continue
  candidates.push(hash)

-- Journal candidates durably. INSERT OR IGNORE avoids colliding with any
-- tombstones that were enqueued since pass1_live.
BEGIN IMMEDIATE
  for hash in candidates:
    INSERT OR IGNORE INTO pending_blob_deletes(hash, enqueued_at) VALUES (?, <now>)
COMMIT

-- Drain via the normal Phase B protocol (§6.3). Phase B's claim step uses
-- `NOT EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)
--  AND NOT EXISTS (SELECT 1 FROM pending_blob_puts WHERE hash = ?)` so any
-- save that journaled an intent between pass1_live and claim blocks the
-- delete. Late-arriving saves see claimed_at != NULL and re-put during
-- post-commit repair.
drainPendingBlobDeletesPhaseB()
```

O(N) over the blob store, intended for operator use, not the hot path. The FS impl walks the CAS directory shard-by-shard; the S3 impl pages `ListObjectsV2`. Mirrors `packages/lib/snapshot-store-sqlite/src/gc.ts:sweepOrphanBlobs` but routes reclamation through the same durable claim state as `sweepArtifacts`.

### 6.5 Startup recovery (in-flight repair drain)

`createArtifactStore` invokes a recovery pass on first use:

1. **Drain `pending_blob_puts`** — any rows older than a configurable grace window (default 5 minutes — must exceed worst-case save latency) from saves that crashed between steps 3 and 5 of §6.1. Each stale intent is handled atomically in a short `BEGIN IMMEDIATE` transaction:
   - If the hash already has a `blob_ready = 0` or `blob_ready = 1` row in `artifacts` → just `DELETE FROM pending_blob_puts WHERE intent_id = ?`. The save either completed past this point (blob_ready = 1) or has its own blob_ready = 0 recovery below — nothing to reclaim.
   - If no `artifacts` row references the hash → `DELETE FROM pending_blob_puts WHERE intent_id = ?` **and** `INSERT OR IGNORE INTO pending_blob_deletes(hash, enqueued_at) VALUES (?, now)` in the same transaction. This converts the orphan intent directly into a sweep tombstone, so normal `sweepArtifacts` (not operator-only scavenger) reclaims the blob on its next Phase B drain. No O(N) scan needed for crashed-pre-insert saves.
2. **Drain `pending_blob_deletes` Phase A-only** — any row with `claimed_at IS NOT NULL` (crashed sweep) is left in place; remote blob deletes happen in the background worker, not inline.
3. **Run a TTL-only Phase A synchronously (metadata only).** Local SQLite DML tombstones rows whose per-row `expires_at` is in the past. **Quota and per-name retention are NOT applied on open** — those are admission controls plus explicit `sweepArtifacts()`, never retroactive deletions triggered by a process restart. This prevents a stricter config or rollback from silently deleting previously valid artifacts at startup. The store becomes available as soon as this commits. No blob I/O, no network.

`blob_ready = 0` rows left by a crashed `saveArtifact` repair are **not** touched synchronously — the open path never calls `blobStore.has()`. Those rows remain invisible (every read-side API filters them), so serving continues correctly even with unresolved in-flight rows.

4. **Kick off a background Phase B worker** — non-blocking after open. It performs, in this order:
   a. Drain `blob_ready = 0` rows. For each row:
      - `blobStore.has(content_hash)`.
      - **Success + true** → promote to `blob_ready = 1`. Done.
      - **Success + false** (the backend is healthy and confirms the blob is absent — the save committed metadata but never finished putting the blob) → increment `repair_attempts` atomically. If the new value ≥ `maxRepairAttempts` (config default 10), force-resolve: delete the row and tombstone the hash. Emit `artifacts.repair_exhausted` log. Caller's save is lost.
      - **Transient backend error** (throw / timeout / network failure — any case where `has()` could not reach a definitive answer): leave the row at `blob_ready = 0`, do **not** increment `repair_attempts`, wait with exponential backoff, retry. Transient outages must not consume the terminal-delete budget — a one-hour S3 outage with 10 retry attempts would otherwise delete committed artifacts whose blobs are still intact.
      - `repair_attempts` counts only confirmed missing-blob observations, not transient backend failures. A committed artifact can only be terminally deleted after the backend definitively reports its blob absent at least `maxRepairAttempts` distinct times — a signal of genuine corruption, not a network blip.
   b. Drain `pending_blob_deletes` via the standard Phase B protocol (§6.3), tolerating transient blob-backend failures — if a `delete` times out, the tombstone stays and the next sweep retries.

5. **Error classification:**
   - Structural/SQLite errors during recovery steps 1–3 are fatal — they represent actual corruption, and proceeding would violate invariants.
   - Remote backend errors in step 4 are best-effort; the worker logs + continues. A transient S3 outage or single corrupted blob does not prevent the store from opening or serving artifact operations. `createArtifactStore` never performs remote blob reads or writes on its critical path.

Recovery is idempotent; invoking it twice is a no-op.

## 7. Error Handling

**Expected failures** (per CLAUDE.md): return `Result<T, ArtifactError>`.
- Quota/invalid-input on save.
- Not-found / forbidden on get/delete/share/revoke.

**Unexpected failures** (SQLite I/O error, disk full, corrupted blob): throw `Error` with `cause` chaining. Operator problems, not API problems.

**Concurrency**: SQLite `BEGIN IMMEDIATE` serializes metadata transactions. Remote blob I/O is always outside the lock; races between save and sweep are closed by the `pending_blob_deletes` tombstone protocol (§6.1 step 4 reclaims; §6.3 Phase B verify-claim-delete; §6.1 step 6 post-commit `has()` re-puts if needed). See the §6.3 race-analysis table for every interleaving.

**Failure isolation**:
- `saveArtifact` step 3 blob write outside the lock: if the subsequent metadata transaction aborts (e.g., quota_exceeded), the blob is either already-referenced (fine) or orphan, reclaimed on next sweep.
- `sweepArtifacts` Phase A: metadata-only single transaction; crash before it commits is a no-op. Crash after commit leaves durable tombstones resumed on restart.
- `sweepArtifacts` Phase B: no SQLite lock held during blob I/O; crash or timeout leaves tombstones for retry. `blobStore.delete` is idempotent (ENOENT / 404 = success).
- `deleteArtifact`: metadata + tombstone insert are atomic. Blob unlink is always deferred to sweep.
- The combined invariant: **a live metadata row never points at a missing blob.** The reconcile path in §6.3 plus the post-commit verify in §6.1 guarantees this across every documented race.

## 8. Security

| Concern                  | Control                                                                                 |
|--------------------------|------------------------------------------------------------------------------------------|
| Cross-session read leak  | Deny-closed ACL; all non-owner rejections return `not_found` on the wire                 |
| Existence probing        | `not_found` is the only wire response for denial — indistinguishable from genuine miss   |
| Write via share          | Shared grantees cannot delete, share, or revoke — **owner-only** writes (also as `not_found` on the wire for non-owners) |
| Path / name confusion    | `name` rejects `/`, `\`, null bytes, > 255 chars                                         |
| Oversized inputs         | `maxArtifactBytes` default 100 MiB                                                       |
| MIME spoofing upstream   | Stored as declared; no server-side sniffing — UI surfaces caveat                         |
| Secrets in errors        | `ArtifactError` payloads carry IDs/hashes only, never raw bytes or stack traces          |
| S3 creds                 | Explicit `ArtifactStoreConfig` only; never read from env implicitly; never logged        |

## 9. Testing

### 9.1 Coverage
CLAUDE.md gate: 80%. Target higher on `artifacts.ts`, `sharing.ts`, `policy.ts` (security-critical).

### 9.2 Layout

```
packages/lib/blob-cas/src/__tests__/
  cas.test.ts                     ← ported from checkpoint/src/__tests__

packages/lib/checkpoint/src/__tests__/
  (unchanged — acts as extraction regression gate)

packages/lib/artifacts/src/__tests__/
  save.test.ts                    ← save, version bump, idempotent-on-content, tags, tombstone-reclaim
  get.test.ts                     ← own session, shared, denied, not-found, TTL-expired
  list.test.ts                    ← by sessionId, by name (all versions), by tags, includeShared
  delete.test.ts                  ← owner delete, non-owner denied, CASCADE on shares, tombstone inserted, blob stays until sweep
  sharing.test.ts                 ← grant, revoke, grantee can read, grantee cannot write/share
  policy.test.ts                  ← TTL sweep, maxSessionBytes eviction, maxVersionsPerName
  concurrency.test.ts             ← two saves same (session,name) serialize; save-reclaims-tombstone; sweep-under-save with post-commit verify
  crash-recovery.test.ts          ← crash between Phase A and Phase B; tombstones drained on restart
  scavenger.test.ts               ← scavengeOrphanBlobs reclaims blobs with no refs + no tombstones (DR path)
  acl-oracle.test.ts              ← non-owner always sees not_found (probe-resistance)
  schema-migration.test.ts        ← pragmas, WAL, indexes, pending_blob_deletes table present

packages/lib/artifacts-s3/src/__tests__/
  s3-blob-store.test.ts           ← contract tests; aws-sdk-client-mock; no live S3
```

### 9.3 Critical regression tests (TDD seed)

1. `save` returns same `id` when content unchanged (no version bump).
2. `get(id, sessionId=other)` with no share row returns `not_found` — never leaks existence. Same holds for `delete`/`share`/`revoke` by non-owner.
3. `delete(artifact)` removes the **metadata row** and inserts a tombstone when hash becomes unreferenced; blob remains on disk until `sweepArtifacts` runs. Assertion: blob present immediately after delete, absent after sweep.
4. `share` then `revoke` then `get` by grantee → `not_found`.
5. `sweepArtifacts({ ttlMs })` deletes expired rows, drains tombstones, removes orphan blobs. Idempotent on re-run.
6. `saveArtifact` quota eviction: oldest versions evicted first (tombstoned); if still exceeds → `quota_exceeded` with no blob persisted to metadata.
7. Concurrent saves to same `(session, name)`: both succeed with versions `{1, 2}`, no lost update.
8. **Save-reclaims-tombstone race**: manually insert a tombstone for hash `H`; invoke `saveArtifact` with bytes hashing to `H`; tombstone must be gone after the save's commit and blob must remain intact.
9. **Sweep-deletes-under-concurrent-save race**: start sweep Phase B's claim step for hash `H`; while paused, invoke a save referencing `H`; simulate sweep continuing to `blobStore.delete`; save's post-commit verify must detect missing blob and re-put. Final state: live metadata row with the blob present.
10. **Crash mid-sweep**: drop the process between Phase A and Phase B; next sweep must drain leftover tombstones and leave no orphan blobs.
11. **Scavenger on empty DB**: with `artifacts` truncated and tombstones lost, `scavengeOrphanBlobs()` must delete every blob in the store (all are orphan).
12. **Delete-then-re-save**: `delete(artifact)` → `save` same bytes → `sweep`. Result: blob still present (save reclaimed tombstone), live metadata row.
13. **TTL on read is non-mutating**: set `ttlMs` tight; after expiry, `getArtifact` returns `not_found` **without** deleting the row. Verify the row is still in SQLite until `sweepArtifacts` runs.
14. **Get-vs-sweep revalidation**: manually remove the blob for a live artifact; `getArtifact` returns `not_found` (row was concurrently deleted before the retry). Then: re-insert blob, remove row, leave blob; `getArtifact` returns `not_found` (row missing, no throw). Finally: live row + missing blob (simulate external corruption); `getArtifact` throws (operator-visible).
15. **BlobStore.list contract**: both FS and S3 impls yield every stored hash exactly once and terminate on a non-growing store. Covered by `runBlobStoreContract`.
16. **Save observes claimed tombstone → re-puts unconditionally** (the exact race identified in R4): sweep Phase B claim commits (`claimed_at` set, lock released). Save runs: tombstone reclaim observes `claimed_at != NULL` → `needsRePut = true`. Sweep's `blobStore.delete(hash)` now runs. Save's step 6 post-commit runs → unconditional `put`. Final state: blob present, live metadata row. Assert: `getArtifact` returns the bytes successfully.
17. **Scavenger journals before deleting**: manually put an orphan blob (no metadata row, no tombstone). Invoke `scavengeOrphanBlobs()`. Between its list-pass and its enqueue-tx, concurrently `saveArtifact` with bytes hashing to that orphan. Verify: the concurrent save's row points at a present blob even after scavenger's Phase B drain completes.
18. **Crash after save COMMIT but before repair UPDATE**: simulate crash immediately after step 5 COMMIT with `blob_ready = 0`, blob present on disk. Restart via `createArtifactStore` → recovery pass promotes the row to `blob_ready = 1`. Assert: `getArtifact` returns the bytes successfully.
19. **Crash after save COMMIT, blob deleted by concurrent sweep, never re-put**: simulate crash after step 5 COMMIT with `blob_ready = 0`, sweep's delete ran before save could repair, blob is missing on disk. Restart → recovery deletes the row + enqueues tombstone for the hash. Assert: no visible artifact; no dangling metadata; `getArtifact` returns `not_found`.
20. **get-during-repair window invisibility**: block a save at step 6 (just after COMMIT, before UPDATE). Concurrently `getArtifact` with that row's `id`. Must return `not_found` (row is `blob_ready = 0`, invisible). Then unblock save → get succeeds. Confirms the invariant "no reader ever sees a row pointing at a missing blob".
21. **Concurrent saves during repair window — version monotonicity**: save A commits `blob_ready = 0` at version N. Before A's step 6 completes, save B starts for the same `(session, name)`. B must allocate version N+1 (not N), INSERT succeeds (no UNIQUE collision). After both complete, `listArtifacts` by name returns both rows at versions N and N+1 in order.
22. **Lost-save repair-window bug** (R7): save v1 = hash A (blob_ready=1). Save B for hash B commits as v2 blob_ready=0. Before B's repair completes, save C for hash A starts. C **must not** idempotent-return v1 — it must allocate v3 = A. After both complete: `listArtifacts` returns v1=A, v2=B, v3=A in that order.
23. **TTL visibility consistency** (R7): create artifact with `ttlMs = 100`. Wait 200ms. Before any sweep runs: `getArtifact` → not_found, `listArtifacts` → excludes the row, `shareArtifact` by owner → not_found. `deleteArtifact` by owner **succeeds** (owner override; TTL-expired rows are still reclaimable by their owner). Non-owner `deleteArtifact` → not_found.
24. **Save after expiry does not collapse onto expired row** (R8): v1 = bytes A at time T, `ttlMs = 100`. At T+200, saveArtifact(bytes A) → must allocate v2 (fresh save), **not** idempotent-return v1. `listArtifacts` returns only v2 (v1 hidden by TTL); after sweep only v2 remains.
25. **Opportunistic save-path TTL reclamation** (R8): session S saves v1 with `ttlMs = 100`; wait 200ms; session S saves v2. After save, `SELECT * FROM artifacts WHERE id = v1_id` must return nothing (reclaimed inside the save tx). The blob's hash must be in `pending_blob_deletes` unless a concurrent ref still holds it.
26. **Owner delete of expired row** (R8): owner saves v1 with `ttlMs = 100`; wait 200ms; owner `deleteArtifact(v1)` → succeeds (returns `ok: true, value: undefined`). Row is gone; blob tombstone enqueued.
27. **In-flight repair not reapable by TTL/quota** (R9): block a save at step 6 with `blob_ready = 0`; set tight `ttlMs`; run `sweepArtifacts()` and trigger a concurrent opportunistic TTL scan via another save. The `blob_ready = 0` row must remain. Unblock repair → row transitions to `blob_ready = 1` cleanly. Save's final UPDATE must not touch 0 rows.
28. **BlobStore consistency contract** (R9): `runBlobStoreContract(factory)` asserts read-after-write — after `put(h)` resolves, `has(h)` returns true immediately; after `delete(h)` resolves, `has(h)` returns false and `list()` omits `h`. Both FS and S3 impls must pass.
29. **sweepArtifacts uses store policy only** (R9): instantiate store with `policy = { ttlMs: 10_000 }`. Invoke `sweepArtifacts()` (no args). Assert rows with `created_at + 10_000 >= now` are preserved; no way for a caller to override retention at sweep time.
30. **Scavenger cannot race save's put-before-insert** (R10): start save, let it complete step 3 (journal pending_blob_puts) and step 4 (blobStore.put), then pause before step 5 BEGIN IMMEDIATE. Concurrently run `scavengeOrphanBlobs()`. Scavenger must NOT delete the blob (live-hash set includes pending_blob_puts entry). Unblock save → completes with blob intact.
31. **Quota admission reserves in-flight bytes** (R10): configure `maxSessionBytes = 100`. Save A (size 60) enters step 5, commits blob_ready = 0, pause before step 7. Save B attempts size 50 → must fail with `quota_exceeded` (60 reserved + 50 pending > 100; no eviction possible since A is in-flight and protected). Unblock A → transitions to blob_ready = 1. Now save C with size 40 succeeds (100 total usage).
32. **Always insert blob_ready = 0** (R10): instrument saveArtifact and verify every INSERT into artifacts writes `blob_ready = 0`; every successful save ends with a separate UPDATE promoting to 1. No direct blob_ready = 1 INSERT path exists.
33. **Startup recovery converts stale pending_blob_puts → pending_blob_deletes** (R10 follow-up): insert a stale `pending_blob_puts` row (older than grace window) referencing a blob that's actually on disk, no matching artifact. Invoke `createArtifactStore`. Assert: the intent row is removed, a corresponding `pending_blob_deletes` row now exists. Run `sweepArtifacts()` → the blob is reclaimed via normal Phase B (not scavenger).
34. **Intent retired on idempotent save** (R10 follow-up): save bytes A at v1 (blob_ready=1). Save bytes A again: must hit idempotent path. After the save returns, `SELECT COUNT(*) FROM pending_blob_puts` must be 0 — no leaked intent row.
35. **Intent retired on quota_exceeded + orphan tombstoned** (R10 follow-up): configure `maxSessionBytes = 50`. Save bytes of size 60 → returns `{ ok: false, error.kind = "quota_exceeded" }`. After the return, `SELECT COUNT(*) FROM pending_blob_puts` must be 0 AND a matching `pending_blob_deletes` row must exist (assuming the hash isn't referenced elsewhere). Next `sweepArtifacts()` reclaims the orphan blob via normal Phase B — no scavenger needed.
36. **Per-row expires_at frozen at save time** (R11): create store with `policy = { ttlMs: 100 }`. Save v1 at T0. At T+200 (v1 expired), close store. Reopen with `policy = { ttlMs: undefined }` (no TTL). `getArtifact(v1_id)` must still return `not_found` — row's `expires_at` is frozen at `T0 + 100`, policy change cannot resurrect it.
37. **Startup recovery auto-sweeps** (R11): save v1 with `ttlMs = 100`. Close store (clean shutdown). Wait 200ms. Reopen via `createArtifactStore`. Without calling `sweepArtifacts()` manually, assert v1's row is gone and its blob tombstone has been drained (blob unlinked from CAS).
38. **Single-writer lock actively enforced** (R12): open `ArtifactStore` A against `dbPath = X`. In the same process, attempt `createArtifactStore({ dbPath: X, ... })` → must throw `"ArtifactStore already open by another process"`. Close A → a fresh `createArtifactStore` on X must now succeed (lock released). Also: spawn a child process that opens X, kill it with SIGKILL (simulates crash with no close), parent process then `createArtifactStore(X)` — must succeed (kernel-released advisory lock).
39. **Owner revoke on expired row** (R11): owner creates v1, shares with session B. Wait TTL+ until v1 expires. Owner `revokeShare(v1, B)` must succeed (owner override), even though v1 is hidden from every read API.
40. **Per-name version retention enforced at save time** (R11): configure `maxVersionsPerName = 2`. Save same name 3 times with different bytes. After the third save returns successfully, `listArtifacts({name})` returns only 2 rows (the 2 newest). The oldest is tombstoned. No sweep invocation was needed.
41. **Read-vs-revoke linearizability** (R12): share v1 from owner O to grantee B. Start `getArtifact(v1, ctx=B)` at its step 3 (blob read in flight). Concurrently `revokeShare(v1, B)` from O — commits before step 3 completes. Step 4 recheck must return not_found (share row gone). Grantee B never sees the bytes.
42. **`close()` releases the lock** (R12): open store at `dbPath = P`. Attempt to open a second one at `P` → throws. Call `close()` on first → second `createArtifactStore({ dbPath: P, ... })` now succeeds. Every method on the closed store throws `"ArtifactStore is closed"`. `close()` is idempotent.
43. **`:memory:` bypasses lock** (R12): open 10 concurrent stores with `dbPath = ":memory:"` — all must succeed without contention. No lock files on disk.
44. **Store-id fingerprint rejects mispaired backends** (R13): create store A at `dbPath = P1, blobDir = B`. Close A. Create store B at `dbPath = P2, blobDir = B` (reuses blobDir). On open, B reads its own fresh `store_id` from its SQLite, compares to `<B>/.store-id`, mismatch → throws `"Blob backend is paired with a different ArtifactStore"`. Neither store ever runs a sweep that could delete the other's blobs.
45. **Store-id fingerprint accepts re-open** (R13): create store at `dbPath = P, blobDir = B`. Close. Re-open same config → succeeds (store_id matches). Saves and reads survive the close/reopen.
46. **Open is non-blocking on remote backend failure** (R13): configure an `S3BlobStore` mock that throws on `delete()` with 30s timeout. Seed DB with tombstones in `pending_blob_deletes`. `createArtifactStore` must return in < 1s — Phase A completes, Phase B is a background task. Store is usable; attempting `getArtifact` on a live row returns bytes. Eventually the transient delete-failure recovers and the tombstones drain.
47. **Open fails loud on local corruption** (R13): corrupt the SQLite file (truncate mid-page). `createArtifactStore` throws with cause — local metadata integrity is not best-effort.
48. **Open never calls blobStore.has on critical path** (R14): instrument a `BlobStore` mock that counts `has()` calls. Open a store with pre-existing `blob_ready = 0` rows and pending tombstones. Assert: zero `has()` calls are made before `createArtifactStore` returns. All repair happens in the background worker. Meanwhile, concurrent get/save operations work immediately.
49. **Store-id bootstrap rejects one-sided missing** (R14): create store, save an artifact, close. Manually delete `<blobDir>/.store-id`. Re-open → throws `"Blob backend is missing store-id sentinel; operator must restore or reset explicitly"`. No silent bootstrap.
50. **Store-id bootstrap accepts both-empty** (R14): fresh `dbPath` + fresh empty `blobDir`. `createArtifactStore` succeeds; both sentinels now present and matching after open.
51. **Store-id bootstrap rejects both-missing-but-non-empty** (R14): create store, save artifact, close. Delete both `<blobDir>/.store-id` and the `meta.store_id` row from SQLite (via direct sqlite3 manipulation). Re-open → throws `"Store-id missing on a non-empty store; operator must restore or reset explicitly"` (the artifacts row still exists).
52. **blob_ready=0 terminal state after maxRepairAttempts** (R15): configure `maxRepairAttempts = 3`. Seed a blob_ready=0 row whose blob is persistently missing (BlobStore always returns has=false). Background worker retries 3 times then deletes row + tombstones hash + emits `artifacts.repair_exhausted` log. Session's quota is released — a new save for the same session succeeds.
53. **Open does not apply quota retroactively** (R15): seed a store with 10 blob_ready=1 rows using the current policy. Close. Reopen with `policy.maxSessionBytes` reduced to a value that would require evicting 5 rows. On open, those 5 rows must NOT be deleted. `listArtifacts` returns all 10. Evictions happen only via explicit `sweepArtifacts()` or the next save hitting quota admission.
54. **Open still applies TTL** (R15): seed rows with `expires_at` in the past. Close. Reopen. On open, those rows are tombstoned (not visible, blob reclaimable). Background Phase B drains the tombstones. Unlike quota, TTL is always applied — per-row frozen `expires_at` represents a wall-clock retention decision made at save time, not a runtime config choice.
55. **Transient backend errors do not trigger terminal delete** (R16): seed a `blob_ready = 0` row whose blob IS intact on disk. Configure the `BlobStore` mock to throw on `has()` for the first 20 attempts, then succeed. Set `maxRepairAttempts = 3`. Background worker must NOT delete the row — `repair_attempts` stays at 0 until the first confirmed answer. Once the backend recovers, `has()` returns true and the row is promoted to `blob_ready = 1`. Assert: no `artifacts.repair_exhausted` log emitted; artifact is readable.
56. **Confirmed-absent blob triggers terminal delete after max attempts** (R16): seed a `blob_ready = 0` row whose blob is definitively absent. Configure `BlobStore` to return `has = false` successfully. Set `maxRepairAttempts = 3`. After 3 iterations (each increments `repair_attempts` on confirmed false), the row is deleted + tombstoned + `artifacts.repair_exhausted` logged.
57. **close() is a full mutation barrier** (R17): start a slow `saveArtifact` (blob put takes 3s). Immediately invoke `close()`. Assert:
    - `close()` blocks until the save finishes (does not early-resolve).
    - During close(), a second `saveArtifact` attempt throws "ArtifactStore is closing" or "closed".
    - After close() resolves, no SQLite mutations happen; opening a new `createArtifactStore` on the same dbPath succeeds with no stale-worker races.
58. **close() awaits in-flight blob deletes** (R17): trigger a `sweepArtifacts` that enters Phase B with a tombstone whose `blobStore.delete` takes 3s. Invoke `close()`. Assert: close() blocks until the delete completes and reconcile runs; a subsequent open on the same store sees a clean `pending_blob_deletes` table — no abandoned in-flight deletes.
59. **close() has no timeout** (R17): mock `blobStore.delete` to hang indefinitely. `close()` does not return on its own (awaits forever). Only killing the process (SIGKILL) releases the lock (kernel release). The new `createArtifactStore` on the same path succeeds via startup recovery draining what's left. This documents the operator-kill escape hatch rather than permitting a race through an unsafe timeout-and-abandon.
60. **close() drains reads** (R18): start a `getArtifact` call where `blobStore.get` takes 3s. Immediately invoke `close()`. Assert:
    - `close()` blocks until `getArtifact` returns.
    - During close, a concurrent `listArtifacts` call throws "ArtifactStore is closing".
    - After close resolves, no SQLite or blob-store activity — a new store on the same dbPath opens without stale-reader races.
61. **Durable rows protected from eviction during repair** (R18): configure `maxVersionsPerName = 2`. Seed v1 (blob_ready=1) and v2 (blob_ready=0, in-flight). Save v3 for same name: admission sees 2 existing + 1 pending = 3 > cap. Would need to evict v1 (only blob_ready=1 candidate), BUT v2 is in-flight in the same (session,name) scope — rule triggers. Save returns `quota_exceeded`. Assert: v1 is NOT evicted; v1 still visible; no data loss. After v2 completes (blob_ready=1), retry of save v3 succeeds (no in-flight rows; safe to evict v1).
62. **No in-flight, eviction proceeds normally** (R18): configure `maxVersionsPerName = 2`. v1 and v2 both blob_ready=1 (no in-flight). Save v3: admission needs to evict v1. No blob_ready=0 rows in scope → safe. v1 tombstoned, v3 inserted as blob_ready=0, repaired to blob_ready=1. Final: v2, v3 visible.

### 9.4 Contract test for `BlobStore`

`runBlobStoreContract(factory)` is exported from `@koi/blob-cas` (where the interface lives). Both the FS impl (also in `@koi/blob-cas`) and the S3 impl (`@koi/artifacts-s3`) run the same suite against their factories. Prevents backend drift and keeps the contract alongside the interface definition.

### 9.5 Golden query wiring (CLAUDE.md mandate)

- `@koi/artifacts` added as `@koi/runtime` dep.
- New entry in `packages/meta/runtime/scripts/record-cassettes.ts` exercising save → list → get.
- Two standalone (no-LLM) golden queries in `packages/meta/runtime/src/__tests__/golden-replay.test.ts`.
- Must pass: `bun run check:orphans`, `bun run check:golden-queries`, `bun run test --filter=@koi/runtime`.

## 10. Documentation

- `docs/L2/artifacts.md` — public L2 docs (standard template: when to use, quick start, API, config, lifecycle).
- `docs/L2/blob-cas.md` — L0u docs for the extracted CAS primitive.
- `docs/L2/checkpoint.md` — updated to note CAS was extracted to `@koi/blob-cas` (no public API break).

## 11. Acceptance Criteria Mapping (from #1651)

| Criterion                                          | Met by                                   |
|---------------------------------------------------|------------------------------------------|
| CRUD API works                                     | §4, §6, save/get/list/delete tests       |
| Versioning preserves history                       | §5 schema, §6.1 version bump, T1 test    |
| TTL and quota policies enforce                     | §6.3 sweep, T5/T6 tests                  |
| Local filesystem backend ships by default          | §3.1 `@koi/artifacts` FS via blob-cas    |
| S3 backend as optional sub-package                 | §3.1 `@koi/artifacts-s3`                 |
| Tests cover all lifecycle paths                    | §9                                       |
| Documented in `docs/L2/artifacts.md`               | §10                                      |

## 12. Open Questions / Follow-ups

- Future PR: `@koi/tool-artifacts` builtin tools (`save_artifact`, `list_artifacts`, etc.) agents can call directly.
- Future PR: `@koi/artifacts-middleware` auto-capture — mirrors claude-code's `runFilePersistence` pattern, scanning a session workspace at turn-end.
- Future PR: streaming save/get once a consumer (browser screenshots, large model outputs) demands it.
- Future PR: GCS / Azure Blob backends, each as `@koi/artifacts-<provider>` sub-packages.

## 13. References

- Issue: [#1651](https://github.com/windoliver/koi/issues/1651)
- V2 rewrite plan: `.claude/plans/v2-rewrite.md`
- CAS precedent: `packages/lib/checkpoint/src/cas-store.ts`
- Metadata store precedent: `packages/lib/snapshot-store-sqlite/src/{schema,gc,sqlite-store}.ts`
- Session ID branded type: `packages/kernel/core/src/ecs.ts:94–146`
- Claude-code file persistence (inspiration, not ported): `/Users/sophiawj/private/claude-code-source-code/src/utils/filePersistence/{filePersistence,outputsScanner}.ts`
- Golden query wiring: `packages/meta/runtime/scripts/record-cassettes.ts`
