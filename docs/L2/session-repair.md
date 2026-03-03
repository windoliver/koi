# @koi/session-repair — Message History Repair Pipeline

Pure-function pipeline that validates and repairs message history integrity before model calls. Prevents unrecoverable 400 errors from corrupted session state.

---

## Why It Exists

LLM APIs (Anthropic, OpenAI) enforce strict message ordering rules: tool results must follow their matching assistant tool_use, no consecutive same-role messages, no duplicates. When session history becomes corrupted — through compaction boundary errors, crash recovery, partial saves, or buggy channel adapters — the API rejects the entire request with a 400 error. Since the corrupt history persists, every retry hits the same error, creating an **unrecoverable error loop**.

Without this package:

1. **Orphan tool results** — A tool message whose matching assistant was compacted away causes permanent API rejection
2. **Duplicate messages** — Retry logic or double-submit produces identical consecutive messages, wasting tokens
3. **Consecutive same-role messages** — Two user messages in a row (no assistant between) can be rejected or confuse the model
4. **No self-healing** — The agent crashes and stays crashed until manual intervention

---

## Architecture

`@koi/session-repair` is an **L0u utility package** — depends only on `@koi/core` (L0) and `@koi/hash` (L0u). Every L1 and L2 package can import it.

```
┌─────────────────────────────────────────────────┐
│  @koi/session-repair  (L0u)                     │
│                                                 │
│  internal.ts         ← shared helpers           │
│  map-call-id-pairs.ts ← callId pair mapping     │
│  repair-session.ts   ← 3-phase pipeline         │
│  needs-repair.ts     ← O(n) fast-path check     │
│  types.ts            ← RepairResult, RepairIssue│
│  index.ts            ← public API surface       │
│                                                 │
├─────────────────────────────────────────────────┤
│  Dependencies                                   │
│                                                 │
│  @koi/core  (L0)   InboundMessage, JsonObject   │
│  @koi/hash  (L0u)  computeContentHash           │
└─────────────────────────────────────────────────┘
```

### Integration points

```
Engine guard (automatic, every model call):

  ModelRequest.messages
    → needsRepair()     ← fast-path: O(n) check, zero allocation if clean
    → repairSession()   ← only if dirty: fix + return repaired messages
    → Anthropic API

Compactor session restore (on session start):

  [restored messages] + [new messages]
    → repairSession()   ← repair the merge seam
    → continue with clean history
```

---

## How It Works

### 3-Phase Pipeline

```
Input messages:  [user, tool(c1), user, user, user]
                        ↑ orphan    ↑ dup   ↑ mergeable

Phase 1 — Orphan Repair
  Insert synthetic assistant before orphan tool(c1)
  Insert synthetic tool after dangling assistant
  → [user, assistant*(c1), tool(c1), user, user, user]

Phase 2 — Dedup
  Remove consecutive identical messages (same sender + same content hash)
  → [user, assistant*(c1), tool(c1), user, user]
                                          ↑ removed duplicate

Phase 3 — Merge
  Merge consecutive same-sender messages (no callId, not pinned, not synthetic)
  → [user, assistant*(c1), tool(c1), user(merged)]
                                     ↑ two user messages → one
```

### Phase 1: Orphan Repair

Scans for callId mismatches using `mapCallIdPairs()`:

- **Orphan tool result** (tool with callId but no matching assistant): inserts a synthetic assistant message before it
- **Dangling tool_use** (assistant with callId but no matching tool result): inserts a synthetic tool message after it

Synthetic messages are marked with `metadata.synthetic: true` and `metadata.repairPhase: "orphan-tool"` so downstream code can identify them. They also inherit `threadId` from the companion message.

### Phase 2: Dedup

Walks adjacent pairs. When same `senderId` is found, lazily computes SHA-256 content hashes via `computeContentHash()`. Removes consecutive duplicates (keeps first).

### Phase 3: Merge

Walks adjacent pairs. Merges consecutive messages when ALL of:
- Same `senderId`
- Neither has a `callId` in metadata
- Neither is `pinned`
- Neither has `metadata.synthetic: true`

Concatenates content blocks, preserves first message's metadata and timestamp.

### Fast-Path Check

`needsRepair()` performs a single O(n) pass to detect if any phase would produce changes. Returns `false` with zero allocation when history is clean — this is the common case.

---

## API Reference

### `repairSession(messages: readonly InboundMessage[]): RepairResult`

Run the full 3-phase pipeline. Returns original array reference when no repairs needed (zero allocation).

```typescript
interface RepairResult {
  readonly messages: readonly InboundMessage[];
  readonly issues: readonly RepairIssue[];
}

interface RepairIssue {
  readonly phase: "orphan-tool" | "dedup" | "merge";
  readonly description: string;
  readonly index: number;
  readonly action: "removed" | "merged" | "inserted" | "kept";
}
```

### `needsRepair(messages: readonly InboundMessage[]): boolean`

Fast O(n) check. Use before `repairSession()` to avoid unnecessary work. The engine guard calls this on every model call/stream.

### `mapCallIdPairs(messages: readonly InboundMessage[]): CallIdPairMap`

Builds callId pairing map. Also used by `@koi/middleware-compactor`'s `pair-boundaries.ts` for atomic group detection.

```typescript
interface CallIdPairMap {
  readonly assistantByCallId: ReadonlyMap<string, number>;
  readonly orphanToolIndices: readonly number[];
  readonly danglingToolUseIndices: readonly number[];
}
```

---

## Examples

### Automatic (engine guard — zero config)

Every agent gets session repair automatically via the engine's default guard extension:

```typescript
import { createKoi } from "@koi/engine";

// Session repair is auto-wired at priority -1 (before all other guards)
const koi = createKoi({ /* ... */ });
// Every model call/stream is now protected
```

### Manual (direct call)

```typescript
import { repairSession, needsRepair } from "@koi/session-repair";

if (needsRepair(messages)) {
  const result = repairSession(messages);
  console.log(`Fixed ${result.issues.length} issues`);
  // Use result.messages instead of original
}
```

### Inspecting repair issues

```typescript
const result = repairSession(messages);
for (const issue of result.issues) {
  console.log(`[${issue.phase}] ${issue.action}: ${issue.description}`);
}
// [orphan-tool] inserted: Inserted synthetic assistant for orphan tool at index 3 (callId: call_abc)
// [dedup] removed: Removed duplicate message at index 7 (senderId: user)
// [merge] merged: Merged consecutive user message at index 9
```

---

## Design Decisions

### Why L0u, not L2?

Session repair is needed by both L1 (`@koi/engine` guard) and L2 (`@koi/middleware-compactor` session restore). L2 packages cannot import from peer L2, and L2 cannot import from L1. Placing it in L0u makes it universally importable.

### Why a guard middleware, not a standalone middleware?

Session repair must run **before** all other middleware (including compactor, pay, audit). As a guard inside `createDefaultGuardExtension()` at priority -1, it's guaranteed to be the first thing that touches the message array. A separate middleware would require users to manually wire it with the correct priority.

### Why 3 phases in this order?

1. **Orphan repair first** — inserts synthetic messages that change the array structure. Must run before dedup/merge which depend on adjacency.
2. **Dedup second** — removes exact duplicates before merge, so merge doesn't accidentally combine a message with its duplicate.
3. **Merge last** — operates on the cleaned array. Synthetic messages from phase 1 are marked `synthetic: true` and excluded from merging.

### Why SHA-256 for dedup instead of reference equality?

Messages may be structurally identical but different object references (deserialized from storage, reconstructed after compaction). `computeContentHash()` from `@koi/hash` provides deterministic comparison regardless of object identity or key order.

### Why lazy hashing?

Hashing is the most expensive operation in the pipeline. The fast path (`needsRepair`) and dedup phase only hash when same-senderId adjacency is found — which is the rare/broken case. Clean histories (the 99% case) never hash.

---

## Performance

| Scenario | Cost |
|----------|------|
| Clean history (common) | `needsRepair()`: O(n) scan, zero allocation, zero hashing |
| Dirty history (rare) | `repairSession()`: O(n) per phase, SHA-256 only for adjacent same-sender pairs |
| callId map build | ~0.1ms for typical session (~100 messages) |

The engine guard calls `needsRepair()` first and only invokes `repairSession()` when damage is detected. For the 99% case of clean histories, the overhead is a single O(n) pass with no allocation.

---

## Layer Compliance

- [x] `@koi/core` (L0) — `InboundMessage`, `JsonObject` types
- [x] `@koi/hash` (L0u) — `computeContentHash` for dedup comparison
- [x] No imports from `@koi/engine` (L1) or peer L2 packages
- [x] All interface properties are `readonly`
- [x] All array parameters are `readonly T[]`
- [x] Immutable — no mutation of inputs or shared state
- [x] Pure functions — deterministic, no side effects, no I/O
