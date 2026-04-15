# @koi/middleware-memory-recall — Frozen-Snapshot Memory Recall

`@koi/middleware-memory-recall` is an L2 middleware that injects persisted
memories at session start using the frozen-snapshot pattern: scan once, cache,
prepend to every model call. Replaces the turn-interval approach from
`@koi/middleware-hot-memory` (v1, archived).

---

## Why frozen snapshot

Both Claude Code and Hermes use frozen snapshots. The recalled memories are
injected once at session start and never refreshed mid-session. This:

- **Preserves prompt cache** — the prefix stays stable across turns
- **Avoids mid-session context drift** — model sees consistent memory state
- **Is simpler** — no cache invalidation, no store-change notification wiring
- **Doesn't compete with explicit recall** — model has `memory_recall` tool
  for mid-session lookups when needed

---

## How it works

```
Session start → first model call → recallMemories() → cache → done
                                         │
                     scan .md files ──────┤
                     score by salience ───┤
                     budget to 8000 tok ──┤
                     format as Markdown ──┘

Subsequent model calls → prepend cached message → next()
```

### Pipeline

1. **Scan** — reads `.md` files from the memory directory via `FileSystemBackend`
2. **Score** — exponential decay (30-day half-life) + type relevance weights
3. **Budget** — greedy selection by salience, no mid-content truncation
4. **Format** — Markdown with `<memory-data>` trust boundary tags
5. **Inject** — prepended as an `InboundMessage` with `senderId: "system:memory-recall"`

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
    tokenBudget: 8000,      // default
    salience: {
      decay: { halfLifeDays: 30 },
      typeWeights: { feedback: 1.2, user: 1.0, project: 1.0, reference: 0.8 },
    },
  },
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

## Lifecycle

| Event | Behavior |
|-------|----------|
| `onSessionStart` | Reset cache — next model call will re-scan |
| First `wrapModelCall` | Call `recallMemories()`, cache result |
| Subsequent `wrapModelCall` | Prepend cached message |
| `wrapModelStream` | Same injection, yield chunks |
| `recallMemories()` error | Warn and proceed without injection |

---

## Dependencies

- `@koi/core` (L0) — `KoiMiddleware`, `FileSystemBackend`, `InboundMessage`
- `@koi/memory` (L0u) — `recallMemories()`, `RecallConfig`
- `@koi/token-estimator` (L0u) — token counting for capability reporting

---

## vs. middleware-hot-memory (v1, archived)

| Aspect | v1 hot-memory | v2 memory-recall |
|--------|--------------|------------------|
| Recall frequency | Every N turns (default 5) | Once per session (frozen) |
| Cache invalidation | Store-change notification | None needed |
| Prompt cache impact | Breaks on refresh turns | Stable prefix |
| Data source | `MemoryComponent.recall()` | `FileSystemBackend` + disk scan |
| Scoring | None (raw recall) | Salience: decay + type weights |
| Trust boundary | Raw text injection | `<memory-data>` escaping |
