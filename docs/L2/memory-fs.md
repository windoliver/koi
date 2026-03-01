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
│   ├── index.ts              ─ Public exports (backend + provider + types)
│   ├── types.ts              ─ MemoryFact (internal), FsMemory, config, DI contracts
│   ├── fs-memory.ts          ─ createFsMemory() factory (~400 LOC)
│   ├── fact-store.ts         ─ File I/O: read/write/append, write queue, cache
│   ├── graph-walk.ts         ─ BFS causal graph expansion with score decay
│   ├── dedup.ts              ─ Jaccard similarity + CJK bigram fallback
│   ├── decay.ts              ─ Exponential decay scoring + Hot/Warm/Cold tiering
│   ├── slug.ts               ─ Entity name sanitization (path traversal guard)
│   ├── summary.ts            ─ Rebuild summary.md from active facts
│   ├── session-log.ts        ─ Append-only daily log
│   ├── provider/             ─ Agent-facing layer (tools + skill)
│   │   ├── memory-component-provider.ts  ─ ComponentProvider factory
│   │   ├── skill.ts          ─ Behavioral instructions for the LLM
│   │   ├── constants.ts      ─ Defaults, operation types
│   │   ├── parse-args.ts     ─ Input validation (ParseResult pattern)
│   │   └── tools/
│   │       ├── store.ts      ─ memory_store tool factory
│   │       ├── recall.ts     ─ memory_recall tool factory
│   │       └── search.ts     ─ memory_search tool factory
│   └── __tests__/
│       ├── e2e.test.ts                ─ Full createKoi + createPiAdapter integration tests
│       ├── e2e-causal-memory.test.ts  ─ Causal graph E2E with real LLM calls
│       └── api-surface.test.ts
└── dist/                      ─ ESM-only build output
```

---

## How It Works

### Wiring into createKoi

The memory backend plugs into the L1 runtime via `createMemoryProvider`, a `ComponentProvider` that attaches five things to the agent entity:

```typescript
const baseDir = "~/.koi/memory";
const fsMemory = await createFsMemory({ baseDir });

createKoi({
  manifest: { name: "my-agent", ... },
  adapter:  createPiAdapter({ model: "anthropic:claude-haiku-4-5-20251001", ... }),
  providers: [
    createMemoryProvider({ memory: fsMemory, baseDir })  ◄── attaches memory
  ],
})
       │
       │  assembles agent entity with:
       │
       ├── MEMORY token ──────────── fsMemory.component  (MemoryComponent)
       ├── tool:memory_store ──────  Tool { execute → .store() }
       ├── tool:memory_recall ─────  Tool { execute → .recall() }
       ├── tool:memory_search ─────  Tool { execute → .listEntities() / .recall() }
       └── skill:memory ───────────  SkillComponent with behavioral instructions

The ReAct loop sees the tools. LLM decides when to call them.
No middleware. No auto-storing. Agent judgment only.
```

### Skill: Teaching the Agent When to Remember

The skill component injects behavioral instructions into the agent's system prompt (via `@koi/context`). It tells the LLM:

- **Where** memory lives on disk (the `baseDir` path and directory structure)
- **What** to store: preferences, relationships, decisions, milestones, corrections
- **What NOT** to store: greetings, temp queries, duplicates, raw transcripts
- **How** to store: one atomic fact per call, with category and related_entities
- **How** to recall: at conversation start, when user references past work, with tier filters
- **How decay works**: hot/warm/cold tiers, access count protection, warming on recall

When `baseDir` is provided to `createMemoryProvider`, the skill content includes the actual storage path so the agent knows where its memories live. Without it, a placeholder is used.

The skill is generated by `generateMemorySkillContent(baseDir)` and can be fully overridden via `skillContent` in the config.

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
memory_store({ content, category, entities, causalParents? })
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
7. Bidirectional causal edges: if causalParents provided,
   update each parent's causalChildren to include new fact ID
  │
  ▼
8. Mark entity as dirty (for summary rebuild)
```

### Recall Flow

When the agent calls `memory_recall`, there are two code paths:

```
memory_recall({ query, limit, tier })
  │
  ├── WITH retriever (DI injected, e.g. @koi/search):
  │     │
  │     ▼
  │   1. retriever.retrieve(query, limit * 2)  ─── semantic/BM25/hybrid search
  │     │
  │     ▼
  │   2. Match scored hits back to fact records
  │     │
  │     ▼
  │   3. Filter: status === "active" only
  │
  ├── WITHOUT retriever (fallback — recency only):
  │     │
  │     ▼
  │   1. Scan all entities, load all facts from cache
  │     │
  │     ▼
  │   2. Filter: status === "active" only
  │     │
  │     ▼
  │   3. Sort by timestamp DESC (newest first)
  │     │
  │     ▼                ⚠️ query string is IGNORED in this path
  │
  └── Both paths then:
        │
        ▼
      4. Apply tier filter (hot/warm/cold)
        │
        ▼
      5. Graph expansion (if graphExpand: true):
         BFS along causalParents + causalChildren edges
         within the same entity, up to maxHops (default: 2).
         Score decays exponentially per hop: score × (0.8 ^ hops)
        │
        ▼
      6. Dedup by fact ID (higher score wins), sort by score, apply limit
        │
        ▼
      7. Update lastAccessed + accessCount (batch write, warms cold facts)
        │
        ▼
      8. Return MemoryResult[] with { content, tier, decayScore,
         lastAccessed, causalParents, causalChildren }
```

**Important**: Without a search retriever, recall is recency-based — it returns the newest active facts regardless of query relevance. For production use, inject a `FsSearchRetriever` backed by `@koi/search` (BM25 + vector + hybrid).

---

## Causal Memory Graph

Facts can be linked with causal edges (`causalParents` / `causalChildren`) to form a directed graph. This enables graph-aware retrieval that recovers causally related facts even when they share no vocabulary with the query.

### Why Causal Edges

AMA-Bench (Feb 2026) showed that flat similarity retrieval loses -43.2% accuracy because causally related facts often use completely different vocabulary:

```
Bug report: "login page times out"
Root cause:  "DB connection pool exhausted"     ← different words
Fix:         "increased pool_size to 20"        ← different words
Result:      "latency dropped to <200ms"        ← different words

Similarity search for "login timeout" finds only the bug report.
Causal graph walk finds the entire chain.
```

### Storing Causal Edges

Pass `causalParents` when storing a fact that was derived from existing facts:

```typescript
// Step 1: Store the root fact
await mem.component.store("DB pool exhausted", {
  relatedEntities: ["infra"],
  category: "root-cause",
});
// Get its ID from recall
const root = await mem.component.recall("DB pool");
const rootId = root[0]?.metadata?.id;

// Step 2: Store a derived fact with causal link
await mem.component.store("increased pool_size to 20", {
  relatedEntities: ["infra"],
  category: "fix",
  causalParents: [rootId],   // ← links to root cause
});
```

Edges are **bidirectional**: storing a child also updates the parent's `causalChildren`. Both directions are traversed during graph expansion.

### Graph-Aware Recall

Pass `graphExpand: true` to walk causal edges during recall:

```typescript
const results = await mem.component.recall("pool exhausted", {
  graphExpand: true,    // enable BFS along causal edges
  maxHops: 2,           // max traversal depth (default: 2)
  limit: 10,
});
```

```
Query: "pool exhausted"
  │
  ▼  hop 0  (direct hit)
┌──────────────────────────────────┐
│ "DB pool exhausted"   score: 1.0 │
└──────────────────────────────────┘
  │  causalChildren
  ▼  hop 1  (score × 0.8)
┌──────────────────────────────────┐
│ "increased pool_size"  score: 0.8│
└──────────────────────────────────┘
  │  causalChildren
  ▼  hop 2  (score × 0.8²)
┌──────────────────────────────────┐
│ "latency <200ms"       score: 0.64│
└──────────────────────────────────┘
```

### Scope & Limitations (v1)

- Edges are **same-entity only**. Cross-entity parent references are stored on the child but the parent's `causalChildren` is only updated if both live in the same entity.
- Adjacency map is rebuilt **per-recall** (no persistent cache). Acceptable for entity-scoped fact sets; may need caching if fact counts grow large.
- Cycle-safe: BFS uses a visited set, so circular edges (A→B→A) terminate correctly.

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

// Store with causal link
await mem.component.store("enabled dark mode in settings", {
  relatedEntities: ["user"],
  category: "action",
  causalParents: ["<parent-fact-id>"],
});

// Recall facts
const results = await mem.component.recall("dark mode", {
  limit: 5,
  tierFilter: "hot",       // optional: "hot" | "warm" | "cold"
  graphExpand: true,        // optional: walk causal edges
  maxHops: 2,               // optional: BFS depth (default: 2)
});
// → [{ content, tier, decayScore, lastAccessed, causalParents, causalChildren, metadata }]
```

### `createMemoryProvider(config): ComponentProvider`

The agent-facing layer. Attaches tools + skill + MEMORY token to the agent entity.

```typescript
import { createFsMemory, createMemoryProvider } from "@koi/memory-fs";

const baseDir = "/path/to/memory";
const mem = await createFsMemory({ baseDir });
const provider = createMemoryProvider({
  memory: mem,
  baseDir,                              // included in skill content
  prefix: "memory",                     // tool name prefix (default: "memory")
  trustTier: "verified",                // trust tier for all tools (default: "verified")
  operations: ["store", "recall", "search"],  // subset of tools (default: all 3)
  recallLimit: 10,                      // max results for recall (default: 10)
  searchLimit: 20,                      // max results for search (default: 20)
  skillContent: "custom instructions",  // override skill content (optional)
});
```

### Tools

| Tool | Input | What It Does |
|------|-------|-------------|
| `memory_store` | `{ content, category?, related_entities?, causal_parents? }` | Store an atomic fact. Auto-dedup + contradiction detection. `causal_parents` links to existing fact IDs. |
| `memory_recall` | `{ query, limit?, tier?, graph_expand?, max_hops? }` | Search memories by query. `graph_expand: true` walks causal edges. Returns `{ results, count }`. |
| `memory_search` | `{ entity?, limit? }` | Browse entity facts or list all known entities. |

### Custom Search (DI)

By default, recall is **recency-based** (newest facts first, query ignored). For semantic search, inject a retriever backed by `@koi/search` or any custom backend:

```typescript
const mem = await createFsMemory({
  baseDir: "/path/to/memory",
  retriever: {
    retrieve: async (query, limit) => {
      // @koi/search: BM25, vector (sqlite-vec), or hybrid (RRF fusion)
      return [{ id: "...", score: 0.95, content: "..." }];
    },
  },
  indexer: {
    index: async (docs) => { /* index documents */ },
    remove: async (ids) => { /* remove from index */ },
  },
});
```

The DI contracts (`FsSearchRetriever`, `FsSearchIndexer`) are local function types — no `@koi/search` import, no L2-to-L2 dependency. They can be adapted from `@koi/search`'s `Retriever` / `Indexer` interfaces at the wiring layer.

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

170+ tests total across 15 test files:

| Test File | Count | What It Covers |
|-----------|-------|----------------|
| `slug.test.ts` | 13 | Path traversal, unicode, edge cases |
| `dedup.test.ts` | 14 | Jaccard similarity, CJK bigrams |
| `decay.test.ts` | 11 | Decay scoring, tier classification |
| `fact-store.test.ts` | 15 | Concurrent writes, corruption recovery, causal backward compat |
| `session-log.test.ts` | 5 | Daily log append |
| `summary.test.ts` | 7 | Summary generation with tier filtering |
| `graph-walk.test.ts` | 9 | BFS expansion, cycle detection, score decay, dedup |
| `fs-memory.test.ts` | 33 | Full integration: store → recall → dedup → decay → causal → graph expansion |
| `provider/tools/store.test.ts` | 10 | Store tool: validation, causal_parents, dedup, errors |
| `provider/tools/recall.test.ts` | 12 | Recall tool: limits, tiers, graph_expand, max_hops, errors |
| `provider/tools/search.test.ts` | 7 | Search tool: entity list, entity lookup, errors |
| `provider/memory-component-provider.test.ts` | 11 | Provider wiring: tokens, prefix, ops subset, detach |
| `api-surface.test.ts` | 2 | DTS snapshot stability |
| `e2e.test.ts` | 18 | Full createKoi + createPiAdapter + real LLM calls |
| `e2e-causal-memory.test.ts` | 3 | Causal graph E2E: store with parents, recall with expansion, full workflow |

E2E tests are gated on `E2E_TESTS=1` + `ANTHROPIC_API_KEY`:

```bash
E2E_TESTS=1 bun test src/__tests__/e2e.test.ts
```

E2E covers: tool wiring, custom prefix, operations subset, tool execution (all 3 tools), store→recall round-trip, dedup, contradiction, tier distribution, summary rebuild, cross-session persistence, 5 LLM integration tests with real API calls through `createPiAdapter`, and 3 causal memory E2E tests (store with `causal_parents`, recall with `graph_expand`, full causal workflow).

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
| Search | Recency default, DI for BM25/vector/hybrid via @koi/search | TF-IDF | Recency |
| Contradiction | Auto-supersede | Manual | None |
| Summary | Markdown generation | None | None |
| Agent decides | Tool-based (agent calls) | Auto-store | Auto-store |
