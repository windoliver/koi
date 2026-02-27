# @koi/memory-fs — File-Based Long-Term Memory

`@koi/memory-fs` is an L2 package that gives any Koi agent persistent, file-based long-term memory. Facts are stored as JSON on disk, organized by entity, with automatic deduplication, contradiction detection, and exponential decay tiering. The agent decides what to remember via `memory_store` / `memory_recall` tool calls — nothing is auto-stored.

---

## Why It Exists

Without memory, every agent session starts from zero. The user says "I'm allergic to peanuts" in session 1, and the agent suggests peanut butter in session 2. `@koi/memory-fs` solves this for single-agent, local-first deployments:

```
  Session 1:                              Session 2 (days later):
    User: "I'm allergic to peanuts"         User: "Suggest a snack"
      │                                       │
      ▼                                       ▼
    Agent thinks:                           Agent thinks:
    "This is important"                     "Let me check memory"
      │                                       │
      ▼                                       ▼
    tool_call: memory_store                 tool_call: memory_recall
    content: "allergic to peanuts"          query: "snack dietary"
    category: "health"                        │
    entities: ["user"]                        ▼
      │                                     found: "allergic to peanuts"
      ▼                                       │
    ~/.koi/memory/entities/user/              ▼
    items.json  ← persisted to disk         "How about apple slices
                                             with sunflower butter!" ✅
```

The agent decides what's worth remembering. Casual messages ("hi", "nice weather") are not stored. Important facts ("I'm vegan", "deadline is March 15") are stored via explicit tool calls.

---

## Architecture

### Layer Position

```
L0  @koi/core         ─ MemoryComponent, MemoryResult, MemoryStoreOptions,
                        MemoryRecallOptions, MemoryTier, SubsystemToken<MEMORY>
L2  @koi/memory-fs    ─ this package (depends only on @koi/core)
```

Zero external dependencies. Zero L1 or peer L2 imports. File I/O uses Node.js `fs/promises`.

### Package Structure

```
packages/memory-fs/
├── src/
│   ├── index.ts          ─ Public exports (createFsMemory + types)
│   ├── types.ts          ─ MemoryFact (internal), FsMemory, config, DI contracts
│   ├── fs-memory.ts      ─ createFsMemory() factory (~330 LOC)
│   ├── fact-store.ts     ─ File I/O: read/write/append, write queue, cache
│   ├── dedup.ts          ─ Jaccard similarity + CJK bigram fallback
│   ├── decay.ts          ─ Exponential decay scoring + Hot/Warm/Cold tiering
│   ├── slug.ts           ─ Entity name sanitization (path traversal guard)
│   ├── summary.ts        ─ Rebuild summary.md from active facts
│   ├── session-log.ts    ─ Append-only daily log
│   └── __tests__/
│       ├── e2e.test.ts   ─ Full createKoi integration tests
│       └── api-surface.test.ts
└── dist/                  ─ ESM-only build output
```

---

## How It Works

### Wiring into createKoi

The memory backend plugs into the L1 runtime via a `ComponentProvider` that attaches three things to the agent entity:

```
createKoi({
  manifest: { name: "my-agent", ... },
  adapter:  createLoopAdapter({ modelCall }),
  providers: [
    createMemoryProvider(fsMemory)       ◄── attaches memory
  ],
})
       │
       │  assembles agent entity with:
       │
       ├── MEMORY token ──────── fsMemory.component  (MemoryComponent)
       ├── tool:memory_store ─── Tool { execute → .store() }
       └── tool:memory_recall ── Tool { execute → .recall() }

The ReAct loop sees the tools. LLM decides when to call them.
No middleware. No auto-storing. Agent judgment only.
```

### Agent Decides What to Remember

```
User: "hi"               → Agent: "Hello!"       (nothing stored)
User: "nice weather"     → Agent: "Indeed!"       (nothing stored)
User: "I'm vegan"        → Agent: "Got it!" +     memory_store()  ←
User: "what's 2+2?"      → Agent: "4"             (nothing stored)
User: "I moved to Tokyo" → Agent: "Exciting!" +   memory_store()  ←

Only 2 out of 5 exchanges stored — agent used judgment.
```

### Store Flow

When the agent calls `memory_store`:

```
memory_store({ content, category, entities })
  │
  ▼
1. Resolve entity: slugify(entities[0] ?? namespace ?? "_default")
  │
  ▼
2. Read active facts for entity (from cache)
  │
  ▼
3. Category pre-filter: only compare against same-category facts
  │
  ▼
4. Jaccard dedup: similarity ≥ 0.7 → REJECT (duplicate)
  │
  ▼
5. Contradiction check: same category + same entities → SUPERSEDE old fact
  │
  ▼
6. Append fact via write queue (temp-file + rename for atomicity)
  │
  ▼
7. Mark entity as dirty (for summary rebuild)
```

### Recall Flow

When the agent calls `memory_recall`:

```
memory_recall({ query, limit })
  │
  ▼
1. Scan all entities, load facts from cache (parallel I/O)
  │
  ▼
2. Filter: status === "active" only (superseded facts hidden)
  │
  ▼
3. BM25-style text matching (or custom retriever if provided)
  │
  ▼
4. Compute decay score + classify tier for each result
  │
  ▼
5. Apply tier filter + limit
  │
  ▼
6. Update lastAccessed + accessCount (batch write)
  │
  ▼
7. Return MemoryResult[] with { content, tier, decayScore, lastAccessed }
```

---

## Fact Lifecycle

Facts decay over time following exponential decay:

```
score = e^(-λ × ageDays)        λ = ln(2) / halfLifeDays (default: 30)

  ≥ 0.7  ──▶  🔴 HOT   (always surfaces in recall)
  ≥ 0.3  ──▶  🟡 WARM  (surfaces if relevant)
  < 0.3  ──▶  🔵 COLD  (archived, rarely surfaces)

  accessCount ≥ 10  ──▶  🟡 WARM  (frequency-protected, stays warm)
```

### Deduplication

```
store("User is vegan")       → stored ✅
store("User is vegan")       → rejected (Jaccard ≥ 0.7) ❌
store("User is vegetarian")  → stored (different enough) ✅
                               "User is vegan" → superseded (contradiction)
```

Jaccard similarity uses word tokens for Latin scripts and character bigrams for CJK (Chinese/Japanese/Korean).

---

## Disk Layout

```
baseDir/
├── entities/
│   ├── alice/
│   │   ├── items.json ──── [{id, fact, category, status, ...}, ...]
│   │   └── summary.md ──── "- prefers cats\n- lives in Tokyo\n- ..."
│   ├── bob/
│   │   ├── items.json
│   │   └── summary.md
│   └── project-alpha/
│       ├── items.json
│       └── summary.md
└── sessions/
    ├── 2026-02-26.md ──── - [14:30] User is vegan
    └── 2026-02-27.md ──── - [09:15] User moved to Tokyo
```

- `items.json`: array of `MemoryFact` objects (internal type, not exported)
- `summary.md`: regenerated by `rebuildSummaries()`, contains Hot + Warm facts sorted by recency
- `sessions/YYYY-MM-DD.md`: append-only daily log

---

## API

### `createFsMemory(config): Promise<FsMemory>`

Factory function. Creates the memory backend.

```typescript
import { createFsMemory } from "@koi/memory-fs";

const mem = await createFsMemory({
  baseDir: "/path/to/memory",     // required: non-empty directory
  dedupThreshold: 0.7,            // Jaccard threshold (default: 0.7)
  freqProtectThreshold: 10,       // access count for warm protection (default: 10)
  decayHalfLifeDays: 30,          // half-life in days (default: 30)
  maxSummaryFacts: 10,            // max facts in summary.md (default: 10)
  retriever: customRetriever,     // optional: semantic search (DI)
  indexer: customIndexer,         // optional: search indexing (DI)
});
```

### `FsMemory`

```typescript
interface FsMemory {
  readonly component: MemoryComponent;              // L0 contract: recall() + store()
  readonly rebuildSummaries: () => Promise<void>;    // regenerate summary.md for dirty entities
  readonly getTierDistribution: () => Promise<TierDistribution>;
  readonly listEntities: () => Promise<readonly string[]>;
  readonly close: () => Promise<void>;               // flush queues, clear caches
}
```

### `FsMemory.component` (the L0 `MemoryComponent`)

```typescript
// Store a fact
await mem.component.store("User prefers dark mode", {
  relatedEntities: ["user"],
  category: "preference",
});

// Recall facts
const results = await mem.component.recall("dark mode", {
  limit: 5,
  tierFilter: "hot",  // optional: "hot" | "warm" | "cold"
});
// → [{ content, tier, decayScore, lastAccessed, metadata }]
```

### Custom Search (DI)

By default, recall uses BM25-style text matching. For semantic search, inject a retriever/indexer:

```typescript
const mem = await createFsMemory({
  baseDir: "/path/to/memory",
  retriever: {
    retrieve: async (query, limit) => {
      // Your vector search here
      return [{ id: "...", score: 0.95, content: "..." }];
    },
  },
  indexer: {
    index: async (docs) => { /* index documents */ },
    remove: async (ids) => { /* remove from index */ },
  },
});
```

The DI contracts (`FsSearchRetriever`, `FsSearchIndexer`) are local function types — no `@koi/search` import, no L2-to-L2 dependency.

---

## Concurrency & Durability

| Concern | Solution |
|---------|----------|
| Concurrent writes | Per-entity async write queue (chained Promises) |
| Atomic writes | Temp-file + rename pattern |
| Crash recovery | Graceful JSON corruption fallback (warns, returns empty) |
| Cache consistency | Lazy write-through `Map<entity, facts[]>` |
| Malformed data | `isMemoryFact` type guard validates every fact from disk |

---

## Testing

92 tests total across 9 test files:

| Test File | Count | What It Covers |
|-----------|-------|----------------|
| `slug.test.ts` | 13 | Path traversal, unicode, edge cases |
| `dedup.test.ts` | 14 | Jaccard similarity, CJK bigrams |
| `decay.test.ts` | 11 | Decay scoring, tier classification |
| `fact-store.test.ts` | 12 | Concurrent writes, corruption recovery |
| `session-log.test.ts` | 5 | Daily log append |
| `summary.test.ts` | 7 | Summary generation with tier filtering |
| `fs-memory.test.ts` | 18 | Full integration: store → recall → dedup → decay |
| `api-surface.test.ts` | 2 | DTS snapshot stability |
| `e2e.test.ts` | 10 | createKoi + createLoopAdapter + tool wiring |

Coverage: **99.51% functions, 98.13% lines**.

E2E tests are gated on `E2E_TESTS=1` + `ANTHROPIC_API_KEY`:

```bash
E2E_TESTS=1 bun test src/__tests__/e2e.test.ts
```

---

## Comparison with Alternatives

| Feature | @koi/memory-fs | OpenClaw | NanoClaw |
|---------|---------------|----------|----------|
| Storage | Local JSON files | JSON files | In-memory |
| Entity routing | Slug-based folders | Entity folders | Flat |
| Dedup | Jaccard + CJK bigrams | Cosine similarity | None |
| Decay | Exponential + freq protect | Linear decay | None |
| Tiering | Hot/Warm/Cold | None | None |
| Concurrency | Per-entity write queue | File locks | N/A |
| Search | BM25 default, DI for vector | TF-IDF | Recency |
| Contradiction | Auto-supersede | Manual | None |
| Summary | Markdown generation | None | None |
| Agent decides | Tool-based (agent calls) | Auto-store | Auto-store |
