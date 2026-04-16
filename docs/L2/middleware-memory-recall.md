# @koi/middleware-memory-recall — Frozen Snapshot + Live Delta

`@koi/middleware-memory-recall` is an L2 middleware that injects persisted
memories into every model call using a two-layer strategy: a **frozen snapshot**
prepended once per session (prefix-cache stable) plus a **live delta** appended
mid-conversation when memories change (Hermes-style). Replaces the turn-interval
approach from `@koi/middleware-hot-memory` (v1, archived).

---

## Why frozen snapshot + live delta

Pure frozen snapshot (Claude Code) keeps the prefix cache stable but hides
mid-session memory writes until the next session. Pure per-turn rebuild
(OpenCode) invalidates the prefix every turn. Koi combines both:

- **Frozen snapshot** prepended once at session start — stable prefix, prompt
  cache preserved across turns
- **Live delta** appended after the conversation history (before the current
  user message) when the memory directory signature changes — new/modified
  memories appear automatically, no cache invalidation of the prefix
- **Fast path** — a cheap `list()` signature gate (name + mtimeMs + size)
  skips the scan when nothing changed; per-turn cost is one directory list
- **Transcript safety** — delta injected *before* the last user turn so that
  `messages.at(-1)` in downstream transcript middleware still points at the
  user's latest message

---

## How it works

```
Session start → first model call → recallMemories() → frozen cache
                                         │
                     scan .md files ──────┤
                     score by salience ───┤
                     budget to 8000 tok ──┤
                     format as Markdown ──┘

Every turn:
  1. list() → fingerprint (name + mtimeMs + size)
     ├── unchanged → reuse cached delta (or none)
     └── changed → scan, diff vs session baseline signatures
                    → build/refresh live delta (budgeted)
  2. Prepend frozen snapshot   (before history, stable prefix)
  3. Insert live delta          (after history, before last user turn)
  4. Optional relevance overlay (after delta, before last user turn)
```

### Pipeline

1. **Scan** — reads `.md` files from the memory directory via `FileSystemBackend`
2. **Score** — exponential decay (30-day half-life) + type relevance weights
3. **Budget** — greedy selection by salience, no mid-content truncation
4. **Format** — Markdown with `<memory-data>` trust boundary tags
5. **Inject** — frozen snapshot prepended; live delta + relevance overlay
   inserted *before* the last user turn as `InboundMessage`s with distinct
   `senderId`s (`system:memory-recall`, `system:memory-live`, `system:memory-relevant`)

### Change detection

Per turn, the middleware computes a fingerprint over the `list()` entries
(name + mtimeMs + size). If the fingerprint matches the previous turn's, no
scan runs. When it changes, the middleware performs a single recursive scan
and compares each file's **FNV-1a content signature** (over name + description
+ type + content) against the session-start baseline to identify genuinely
new or modified memories — this catches in-place edits where mtime or size
didn't change. Deletions are tracked as "stale frozen IDs" so the overlay
stops offering them as relevance candidates.

### Priority

**310** — runs after extraction (305), before the model sees the request.

---

## Configuration

```typescript
import { createMemoryRecallMiddleware } from "@koi/middleware-memory-recall";

const mw = createMemoryRecallMiddleware({
  fs: fileSystemBackend,    // reads .md files
  recall: {
    memoryDir: "/path/to/memory",
    tokenBudget: 8000,      // default (frozen snapshot)
    salience: {
      decay: { halfLifeDays: 30 },
      typeWeights: { feedback: 1.2, user: 1.0, project: 1.0, reference: 0.8 },
    },
  },
  liveDeltaMaxTokens: 4000, // default — budget for the live delta block
});
```

### Token budget

Default 8000 tokens (~6% of 128K context). Configurable via `recall.tokenBudget`.
The formatted output includes:

- Section heading (`## Memory`)
- Trusting-recall note (verify before recommending)
- Per-memory blocks with `<memory-data>` trust boundary

### Salience scoring

Composite score: `max(decayScore * typeRelevance, 0.1)`

- **Decay**: `exp(-ln(2)/30 * ageDays)` — 30-day half-life
- **Type weights**: feedback=1.2, user=1.0, project=1.0, reference=0.8
- **Floor**: 0.1 prevents zero-collapse for cold memories

---

## Trust boundary

All user-derived fields (name, type, content) are placed inside `<memory-data>`
tags with `<` escaped to `&lt;`. Metadata is JSON string literals. Static headings
prevent user content from being interpreted as instructions:

```
### Memory entry
<memory-data>
{"name":"User role","type":"user"}
---
Deep Go expertise, new to React.
</memory-data>
```

---

## Relevance selector (optional)

When the frozen snapshot is truncated (memory count exceeds token budget), an
optional per-turn relevance selector picks the most relevant non-frozen memories
for the current user query via a lightweight model side-query.

The selector prompt uses opaque memory record IDs — never filesystem paths or
filenames. Selected IDs are mapped back to records server-side and injected
through the same trusted `<memory-data>` formatting as the frozen snapshot.

Configured via `relevanceSelector` in the middleware config:

```typescript
const mw = createMemoryRecallMiddleware({
  fs: fileSystemBackend,
  recall: { memoryDir: "/path/to/memory" },
  relevanceSelector: {
    modelCall: adapter.complete,  // lightweight model (Haiku)
    maxFiles: 5,
    maxTokens: 4000,             // budget for relevance overlay
  },
});
```

---

## Lifecycle

| Event | Behavior |
|-------|----------|
| `onSessionStart` | Reset per-session state (frozen cache, baseline signatures, live delta, fingerprint) |
| First `wrapModelCall` | Call `recallMemories()`, record baseline signatures + fingerprint, cache frozen snapshot |
| Subsequent `wrapModelCall` | List → fingerprint → reuse or refresh live delta, inject frozen + delta + (optional) relevance overlay |
| `wrapModelStream` | Same injection, yield chunks |
| `recallMemories()` error | Warn and proceed without injection (fail-open) |

Per-session state is isolated per `sessionId` — concurrent sessions do not
share caches. State keys are pruned when a session's `onSessionStart` fires
again.

---

## Dependencies

- `@koi/core` (L0) — `KoiMiddleware`, `FileSystemBackend`, `InboundMessage`
- `@koi/memory` (L0u) — `recallMemories()`, `RecallConfig`
- `@koi/token-estimator` (L0u) — token counting for capability reporting

---

## vs. middleware-hot-memory (v1, archived)

| Aspect | v1 hot-memory | v2 memory-recall |
|--------|--------------|------------------|
| Recall frequency | Every N turns (default 5) | Frozen snapshot (once) + live delta (per turn, signature-gated) |
| Cache invalidation | Store-change notification | Per-turn `list()` fingerprint + FNV-1a content signatures |
| Prompt cache impact | Breaks on refresh turns | Stable prefix; delta inserted after history |
| Data source | `MemoryComponent.recall()` | `FileSystemBackend` + disk scan |
| Scoring | None (raw recall) | Salience: decay + type weights |
| Trust boundary | Raw text injection | `<memory-data>` escaping |
