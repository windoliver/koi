# @koi/checkpoint

Session-level rollback: capture conversation history + file-system state at every turn boundary, restore atomically with `/rewind <n>`.

## Purpose

Implements the capture and restore halves of #1625. At end of every turn, snapshots the agent's conversation + the file operations the agent performed during that turn. On `/rewind n`, walks the snapshot chain back n steps and restores both conversation and tracked files to that point with crash-safe convergence semantics.

## Layered architecture

```
@koi/checkpoint              (L2, this package)
   │
   ├─ @koi/snapshot-store-sqlite   (L2, storage adapter)
   ├─ @koi/core                    (L0, types: AgentSnapshot, FileOpRecord, CompensatingOp, SNAPSHOT_STATUS_KEY)
   ├─ @koi/hash                    (L0u, content hashing)
   ├─ @koi/git-utils                (L0u, git status for drift detection)
   └─ @koi/errors                   (L0u)
```

This package owns three concerns:

1. **Capture** — engine middleware that hooks turn-complete and intercepts Edit/Write/MultiEdit
2. **CAS blob store** — content-addressed file storage for the bytes referenced by `FileOpRecord` and `CompensatingOp.restore`
3. **UX** — `/rewind` slash command, queueing protocol for in-flight requests, TUI markers

The chain storage layer (`@koi/snapshot-store-sqlite`) is a separate L2 adapter so the deterministic-replay sibling package can reuse it.

## CAS blob store

File contents are stored in a content-addressed directory:

```
~/.koi/file-history/
  {first-2-hex-of-hash}/
    {full-sha256-hex}     ← raw file bytes
```

| Property | Value |
|---|---|
| Hash | SHA-256 |
| Chunk size | 64 KB streaming via `Bun.file(path).stream()` |
| Memory bound | ~64 KB regardless of file size |
| Dedup | Automatic — same content across snapshots/sessions = one blob |
| Binary safe | Yes — hash operates on bytes, not strings |

Blobs are referenced by `FileOpRecord.preContentHash` / `postContentHash` (defined in `@koi/core`) and by `CompensatingOp.restore.contentHash`.

## Capture: end-of-turn snapshot

Capture happens **after** the model and all tool calls have quiesced, before the next user message is accepted. This avoids the empty-snapshot race other agent runtimes have shipped with (where capture-on-user-message-receipt completes before async edit tools fire).

```
turn N:
  user message received
  → engine streams model output
  → tool calls execute (Edit/Write/MultiEdit append FileOpRecord to in-memory buffer)
  → model produces final message
  → engine becomes idle
  → checkpoint middleware: end-of-turn capture
       1. Hash any new content (streaming)
       2. Write blobs to CAS
       3. Insert SnapshotNode with FileOpRecord[] payload
  → ready for turn N+1
```

### Two-phase capture (latency budget)

The user-perceived critical path between turn N and turn N+1 must stay fast (~10–20 ms typical). Capture is split:

| Phase | Work | Budget |
|---|---|---|
| Critical (sync) | Hash files, write blobs to CAS, insert chain node | ~10–20 ms |
| Deferred (microtask) | `git status` for drift detection, blob existence verification, prune + GC | ~80 ms, runs in background |

Drift warnings appear on the snapshot a beat after creation. The rewind UI does not need them until the user actually rewinds.

### Op-kind capture matrix

`FileOpRecord` is a discriminated union by `kind`:

| Kind | Captured fields | Compensating op on rewind |
|---|---|---|
| `create` | `postContentHash` | `delete` (file did not exist before) |
| `edit` | `preContentHash`, `postContentHash` | `restore preContentHash` |
| `delete` | `preContentHash` | `restore preContentHash` |

Renames are captured as a `delete + create` pair sharing a `renameId`. The rewind UI may present them as a single operation; the storage layer treats them as two independent ops.

## Restore protocol

`/rewind n` restores both file state and conversation atomically via an **ordered + idempotent** protocol — no two-phase commit:

```
1. Walk N steps back through the chain → identify target SnapshotNode
2. For each FileOpRecord between target and head, compute compensating op
3. Apply compensating ops to filesystem (CAS writes are no-ops on hash match)
4. Write new conversation log to <session>.jsonl.tmp + fsync
5. Atomic rename(2) over <session>.jsonl
6. Update chain head pointer in SQLite
```

Crash safety comes from **idempotency**, not from a coordinator: re-running `restore(N)` after a crash converges on the target state because every step is a fixed point. Files are restored by hash (CAS write of an existing blob is a no-op), and the conversation log uses tmp+rename which is atomic at the OS level.

## Soft-fail contract

If the capture step fails at end of turn (disk full, store error, etc.), the turn proceeds. The snapshot is recorded with `SNAPSHOT_STATUS_KEY = "incomplete"` in its metadata and is **skipped on rewind** with a user-visible warning. Checkpoint failure does NOT abort the agent loop — it is a recovery feature, not a correctness feature.

## In-flight contract (queue between turns)

Rewind requests received during a tool call are queued; they fire when the engine returns to `idle`. The UI shows a "rewind queued" indicator. There is no mid-turn rewind — this sidesteps the per-tool cancellation problem (Bash subprocesses cannot be safely cancelled mid-syscall).

| Engine state | Rewind request | Behavior |
|---|---|---|
| `idle` | Immediate | Fires immediately |
| `tool-call running` | Queued | Fires after current tool completes and engine returns to idle |
| `model streaming` | Queued | Fires after model completes |

## Cache neutrality

The middleware truncates the conversation log to the snapshot point and does **nothing else** with messages. Provider-side prompt cache is unaffected by this package; the restored prefix is exact, and providers treat exact prefixes as cache hits naturally.

This requires the system prompt to stay free of dynamic content (timestamps, turn counters, mutating tool lists). That precondition is enforced elsewhere — the checkpoint package does not police it.

## Drift warnings

`git status --porcelain` runs in the deferred phase of capture. Any changes that don't correspond to a tracked `FileOpRecord` from the current turn are recorded as `AgentSnapshot.driftWarnings: readonly string[]` (typically `M path/to/file.ts`, `?? new-untracked.ts`).

On `/rewind`, the UI surfaces these:

```
Rewinding 3 turns...
✓ Restored 5 tracked files
⚠ 2 files were modified outside checkpoint tracking and will not be restored:
    M src/build.sh
    ?? generated/output.json
```

Drifted files are NOT restored. The user is informed.

## Configuration

| Key | Default | Description |
|---|---|---|
| `maxSnapshots` | 500 per chain | Chain prune cap |
| `maxBlobBudgetBytes` | 2 GiB | CAS storage budget; mark-and-sweep GC triggers when exceeded |
| `retentionDays` | 30 | Time-based prune cutoff |
| `streamingChunkSize` | 65536 (64 KB) | Hash chunk size |

## API

```typescript
import { createCheckpointMiddleware } from "@koi/checkpoint";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";
import type { AgentSnapshot } from "@koi/core";

const store = await createSnapshotStoreSqlite<AgentSnapshot>({
  path: "~/.koi/snapshots.sqlite",
  blobDir: "~/.koi/file-history",
  extractBlobRefs: extractBlobRefsFromAgentSnapshot,
});

const checkpoint = createCheckpointMiddleware({
  store,
  blobDir: "~/.koi/file-history",
  config: {
    maxSnapshots: 500,
    maxBlobBudgetBytes: 2 * 1024 * 1024 * 1024,
  },
});

const koi = createKoi({
  middleware: [checkpoint /* others */],
});

// Programmatic rewind (also exposed as the /rewind slash command)
await koi.checkpoint.rewind(3);                    // rewind 3 turns
await koi.checkpoint.rewindTo("snapshot-id-abc");  // rewind to a specific node
```

## Testing

The package ships with four mandatory test suites (per #1625 acceptance criteria):

| Suite | What | Approx tests |
|---|---|---|
| **Crash injection** | Inject failure at every protocol step boundary, assert re-run convergence | 10–15 |
| **Op-kind matrix** | create/edit/delete × empty/text/binary/chunk-boundary/large + targeted tests for rename, symlink, mode bits, unicode paths | ~30 |
| **In-flight queue** | Rewind during tool-call / model-streaming / quiescent → queued state → fires on idle | 3 |
| **Negative path** | Drift detection, soft-fail, missing blob, corrupt SQLite, disk full, eviction with head protection, store error | ~12 |

Plus one happy-path round-trip: agent edits 3 files across 5 turns, rewind 2, exact intermediate state restored.

The crash-injection harness is the test that validates the entire ordered+idempotent atomicity strategy. It is not optional.

## Out of scope

- Restoring bash-mediated changes (`rm`, `mv`, `sed -i`, build artifacts) — surfaced as drift warnings only
- Restoring directory creation/deletion — CAS captures file content only
- Restoring permission/ownership changes beyond what `FileOpRecord` records
- Re-warming provider-side prompt cache — providers don't expose this
- Cross-session restore — each session's chain is independent

## Layer

L2 — depends on `@koi/core` (L0), `@koi/snapshot-store-sqlite` (L2 storage adapter), `@koi/hash` (L0u), `@koi/git-utils` (L0u), `@koi/errors` (L0u).
