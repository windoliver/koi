# @koi/artifacts

Versioned, session-scoped file lifecycle for agent-created outputs. Metadata in SQLite, bytes in a content-addressed blob store (`@koi/blob-cas`), single-writer advisory lock, crash-safe save protocol.

This is Plan 2 of issue #1651. Plan 3 (#1920) adds TTL + quota lifecycle. Plan 4 (#1921) adds background repair. Plan 5 (#1922) adds pluggable backends (S3). Plan 6 (#1923) ships agent-facing tool governance.

## Public surface

```ts
import { createArtifactStore } from "@koi/artifacts";

const store = await createArtifactStore({
  dbPath: "/path/to/store.db",
  blobDir: "/path/to/blobs",
});

// save → get → list → delete → share → revoke → close
await store.saveArtifact({ sessionId, name, data, mimeType, tags });
await store.getArtifact(id, { sessionId });
await store.listArtifacts(filter, { sessionId });
await store.deleteArtifact(id, { sessionId });
await store.shareArtifact(id, withSessionId, { ownerSessionId });
await store.revokeShare(id, fromSessionId, { ownerSessionId });
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
| `pending_blob_deletes` | Tombstone queue for orphaned blobs (`hash`, `enqueued_at`, `claimed_at`) — Plan 4 drains this |
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
}
```

## L3 wiring

`@koi/runtime` exposes an `artifacts: { store, sessionId }` config that produces a ComponentProvider attaching four agent-facing tools: `artifact_save`, `artifact_get`, `artifact_list`, `artifact_delete`. The TUI (`koi tui`) opens a per-process store at `~/.koi/artifacts/` and binds calls to the active TUI session. Advisory-lock contention (concurrent TUIs) logs to stderr and disables artifact tools for the second process rather than aborting the session.

## Testing

- Unit: 87 tests in `packages/lib/artifacts/src/__tests__/` covering CRUD, ACL, validation, lock, migration, recovery, and concurrent-save edge cases.
- Integration: 5 standalone Golden tests + 1 ATIF trajectory-replay test in `packages/meta/runtime/src/__tests__/golden-replay.test.ts` (cassette: `fixtures/artifacts-roundtrip.trajectory.json`).
- TUI corner cases (manual): concurrent-TUI degradation, bogus-id not_found, list filters, delete-then-get.
