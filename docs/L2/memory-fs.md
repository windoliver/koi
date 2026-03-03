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
│   ├── category-inferrer.ts   ─ createKeywordCategoryInferrer() — keyword-based auto-categorization
│   ├── fs-memory.ts          ─ createFsMemory() factory (~400 LOC)
│   ├── fact-store.ts         ─ File I/O: read/write/append, write queue, cache
│   ├── graph-walk.ts         ─ BFS causal graph expansion with score decay
│   ├── entity-index.ts       ─ In-memory reverse index for cross-entity lookup
│   ├── cross-entity.ts       ─ Cross-entity BFS expansion with entity-hop decay
│   ├── dedup.ts              ─ Jaccard similarity + CJK bigram fallback
│   ├── decay.ts              ─ Exponential decay scoring + Hot/Warm/Cold tiering
│   ├── salience.ts           ─ Composite salience scoring (similarity × access × decay)
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
memory_store({ content, category?, entities, causalParents? })
  │
  ▼
1. Resolve entity: slugify(entities[0] ?? namespace ?? "_default")
  │
  ▼
2. Resolve category:
   explicit category provided? → use it
   categoryInferrer configured? → infer from content (keyword regex)
   neither? → fall back to "context"
  │
  ▼
3. Read active facts for entity (from cache)
  │
  ▼
4. Category pre-filter: only compare against same-category facts
  │
  ▼
5. Jaccard dedup: similarity ≥ 0.7 → REJECT (duplicate)
  │
  ▼
6. Contradiction check: same category + same entities → SUPERSEDE old fact
  │
  ▼
7. Append fact via write queue (temp-file + rename for atomicity)
  │
  ▼
8. Bidirectional causal edges: if causalParents provided,
   update each parent's causalChildren to include new fact ID
  │
  ▼
9. Mark entity as dirty (for summary rebuild)
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
      5. Causal graph expansion (if graphExpand: true):
         BFS along causalParents + causalChildren edges
         within the same entity, up to maxHops (default: 2).
         Score decays exponentially per hop: score × (0.8 ^ hops)
        │
        ▼
      6. Cross-entity expansion (if graphExpand: true):
         BFS across entity boundaries via relatedEntities links.
         Uses in-memory reverse index for O(1) lookup.
         Score decays per entity hop: score × (entityHopDecay ^ hop)
         Bounded by maxEntityHops (default: 1) and perEntityCap (default: 10)
        │
        ▼
      7. Composite salience scoring (enabled by default):
         Normalize raw scores to [0.1, 1.0] (min-max with floor)
         salience = similarity × log(accessCount + 2) × decayScore
         Frequently-reinforced facts rank higher than raw BM25 alone
        │
        ▼
      8. Sort by salience desc, apply limit
        │
        ▼
      9. Update lastAccessed + accessCount (batch write, warms cold facts)
        │
        ▼
     10. Return MemoryResult[] with { content, tier, decayScore,
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

### Scope & Limitations

- Causal edges (`causalParents`/`causalChildren`) are **same-entity only**. Cross-entity parent references are stored on the child but the parent's `causalChildren` is only updated if both live in the same entity.
- The causal adjacency map is rebuilt **per-recall** (no persistent cache). Acceptable for entity-scoped fact sets; may need caching if fact counts grow large.
- Cycle-safe: BFS uses a visited set, so circular edges (A→B→A) terminate correctly.

---

## Cross-Entity Graph Traversal

Facts are stored under a single entity folder (the first entry in `relatedEntities`), but may reference multiple entities. Cross-entity traversal discovers these connections automatically during recall.

### The Problem

```
store("Alice works on Project Alpha", { relatedEntities: ["alice", "project-alpha"] })

  → stored under entities/alice/items.json  (alice is relatedEntities[0])
  → entities/project-alpha/ has NO knowledge of this fact
```

Without cross-entity traversal, querying "Project Alpha" only returns facts stored directly under `project-alpha/`. The fact about Alice working on the project is invisible.

### How It Works

When `graphExpand: true` is enabled, recall runs a **two-phase expansion**:

```
Phase 1 — Causal BFS (existing, within single entity):
  Walk causalParents + causalChildren edges
  Score: original × (0.8 ^ hops)

Phase 2 — Cross-entity BFS (new, across entity boundaries):
  Walk relatedEntities links via reverse index
  Score: original × (entityHopDecay ^ entityHops)
```

The cross-entity phase uses an **in-memory reverse index** that maps each entity name to facts stored in *other* entities that reference it:

```
Reverse Index (built lazily on first recall):

  "project-alpha" → [
    { factId: "abc", sourceEntity: "alice" },      ← "Alice works on Project Alpha"
    { factId: "def", sourceEntity: "bob" },         ← "Bob reviews Project Alpha PRs"
  ]

  "team-x" → [
    { factId: "ghi", sourceEntity: "alice" },       ← "Alice joined Team X"
  ]
```

### Configuration

Three new fields in `FsMemoryConfig` control cross-entity behavior:

| Field | Default | Purpose |
|-------|---------|---------|
| `entityHopDecay` | 0.5 | Score multiplier per entity hop (steeper than causal 0.8) |
| `maxEntityHops` | 1 | Max depth of entity-hop traversal |
| `perEntityCap` | 10 | Max results per source entity (prevents flooding) |

### Example

```typescript
// Store facts across entities
await mem.component.store("Alice works on Project Alpha", {
  relatedEntities: ["alice", "project-alpha"],
  category: "context",
});
await mem.component.store("Project Alpha uses Rust", {
  relatedEntities: ["project-alpha"],
  category: "tech",
});

// Query Project Alpha — finds both facts
const results = await mem.component.recall("anything", {
  graphExpand: true,
  limit: 20,
});
// → "Project Alpha uses Rust"           score: 1.0  (direct match)
// → "Alice works on Project Alpha"      score: 0.5  (cross-entity, 1 hop)
```

### Cycle & Flood Protection

| Mechanism | Protection |
|-----------|-----------|
| Visited-entity set | Prevents A→B→A infinite loops |
| `maxEntityHops` (default 1) | Bounds traversal depth |
| `perEntityCap` (default 10) | Limits results per source entity |
| `entityHopDecay` (default 0.5) | Cross-entity results rank below direct matches |
| Status filter | Only `active` facts are returned (superseded facts excluded) |

### Performance

- **Zero additional I/O**: The reverse index is built lazily from the in-memory fact cache on first recall. Subsequent recalls reuse the index.
- **Incremental updates**: Every `store()` call updates the index immediately — no rebuild needed.
- **O(1) lookup**: Index is a `Map<entity, Array<{factId, sourceEntity}>>` with `Set`-based dedup.

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

### Deduplication & Merge

The store pipeline uses three similarity zones:

```
Jaccard similarity:
  [dedupThreshold, 1.0]      → SKIP (or reinforce if requested)
  [mergeThreshold, dedup)     → MERGE (if mergeHandler provided)
  [0, mergeThreshold)         → NEW FACT (fall through to supersede check)

Defaults: dedupThreshold = 0.7, mergeThreshold = 0.4
```

```
store("User is vegan")           → stored ✅
store("User is vegan")           → rejected (Jaccard ≥ 0.7) ❌
store("User is vegan and GF")    → MERGE zone (Jaccard ~0.5) → mergeHandler called
                                    → "User is vegan and gluten-free" ✅ (enriched)
store("User is vegetarian")      → stored (different enough) ✅
                                    "User is vegan" → superseded (contradiction)
```

Jaccard similarity uses word tokens for Latin scripts and character bigrams for CJK (Chinese/Japanese/Korean).

### LLM-Based Merge Handler

When a new fact is related but not identical (similarity in the merge zone), a `MergeHandler` callback enriches the existing fact instead of creating a duplicate:

```typescript
const mem = await createFsMemory({
  baseDir: "/path/to/memory",
  mergeHandler: async (existing, incoming) => {
    // Call any LLM to combine the two facts
    const response = await myModel.complete(
      `Merge these facts:\n1: ${existing}\n2: ${incoming}`,
    );
    return response.text; // or undefined to fall through to supersede
  },
  mergeThreshold: 0.4, // default: 0.4
});
```

The handler is DI — `@koi/memory-fs` stays LLM-agnostic. The `@koi/context-arena` (L3) auto-wires one using the summarizer model.

Merge behavior:
- Handler returns `string` → old fact superseded, merged text stored with combined causal parents
- Handler returns `undefined` or `""` → falls through to supersede check
- Handler throws → error logged, falls through (original fact not lost)

### Auto-Category Inference

When agents store facts via `memory_store` without an explicit `category`, the fact defaults to `"context"`. As memory stores grow (100+ facts), this "context" bucket becomes a junk drawer — degrading dedup, merge, and contradiction detection (all category-scoped).

A `CategoryInferrer` DI slot on `FsMemoryConfig` solves this by auto-assigning categories at write time:

```typescript
type CategoryInferrer = (content: string) => string | Promise<string>;
```

The built-in `createKeywordCategoryInferrer()` maps 6 categories via regex — zero LLM cost:

| Category | Trigger keywords |
|----------|-----------------|
| `decision` | chose, decided, picked, went with, settled on |
| `error-pattern` | error, failed, bug, crash, exception, broken |
| `preference` | prefers, likes, always uses, favourite, dislikes |
| `correction` | corrected, fixed, wrong, mistake, shouldn't have |
| `milestone` | completed, shipped, launched, deployed, released |
| `relationship` | works with/for/at, reports to, manages, team |
| *(no match)* | falls back to `"context"` |

Rules are evaluated top-to-bottom; first match wins. All patterns are case-insensitive.

```typescript
import { createFsMemory, createKeywordCategoryInferrer } from "@koi/memory-fs";

const mem = await createFsMemory({
  baseDir: "/path/to/memory",
  categoryInferrer: createKeywordCategoryInferrer(),
});

await mem.component.store("We decided to use Bun");
// → category: "decision" (matched "decided")

await mem.component.store("Build failed after upgrading tsup");
// → category: "error-pattern" (matched "failed")

await mem.component.store("The sky is blue");
// → category: "context" (no match — fallback)

// Explicit category always wins — inferrer is not called
await mem.component.store("We decided on React", { category: "milestone" });
// → category: "milestone"
```

**Customization**: Add domain-specific rules (prepended, higher priority) or override the fallback:

```typescript
const inferrer = createKeywordCategoryInferrer({
  additionalRules: [
    { category: "security", pattern: /\b(?:vulnerability|CVE|exploit)\b/i },
  ],
  fallback: "general", // instead of "context"
});
```

**Async inferrers**: The DI slot accepts `Promise<string>`, so LLM-backed classifiers work too:

```typescript
const mem = await createFsMemory({
  baseDir: "/path/to/memory",
  categoryInferrer: async (content) => {
    const response = await myModel.classify(content);
    return response.category;
  },
});
```

**Error handling**: If the inferrer throws (LLM timeout, etc.), the error is logged and category falls back to `"context"` — the fact is never lost.

**Context-Arena integration**: `createContextArena` auto-wires `createKeywordCategoryInferrer()` when `memoryFs` is configured. No extra config needed:

```typescript
const bundle = await createContextArena({
  summarizer: myModel,
  sessionId,
  getMessages: () => messages,
  memoryFs: {
    config: { baseDir: "/data/memory" },
    // categoryInferrer auto-wired ← keyword-based, zero LLM cost
    // mergeHandler auto-wired ← uses summarizer
  },
});
```

#### Why This Matters

Without auto-categorization, all uncategorized facts land in `"context"`:

```
"context" bucket (before):
  - "We decided to use Bun"        ← should be "decision"
  - "Build failed on CI"            ← should be "error-pattern"
  - "User prefers dark mode"        ← should be "preference"
  - "Deployed v2.0 to prod"         ← should be "milestone"

  Dedup compares ALL of these against each other — false positives.
  Contradiction detection treats them as same-category — false supersessions.
```

With auto-categorization, facts are bucketed correctly. Dedup only compares decisions against decisions, errors against errors, etc. Merge and contradiction detection become more precise.

---

## Per-User Memory Isolation

Multi-user agents (e.g., Telegram bots) need per-user memory boundaries. Without isolation, Alice's preferences leak into Bob's recall.

### The Problem

```
Shared memory (before):
  Alice: "I like cats"    ──▶  baseDir/entities/preference/items.json
  Bob:   "I like dogs"    ──▶  baseDir/entities/preference/items.json  ← same file!
  Bob:   recall "cats"    ──▶  finds Alice's fact ❌
```

### The Solution: User-Scoped Memory

`createUserScopedMemory` manages an LRU cache of per-user `FsMemory` instances, each with its own on-disk directory:

```typescript
import { createUserScopedMemoryProvider } from "@koi/memory-fs";

const provider = createUserScopedMemoryProvider({
  baseDir: "/data/bot-memory",
  userScoped: true,
  maxCachedUsers: 100, // LRU cache size (default: 100)
});
```

```
Per-user memory (after):
  Alice: "I like cats"    ──▶  baseDir/users/alice/entities/preference/items.json
  Bob:   "I like dogs"    ──▶  baseDir/users/bob/entities/preference/items.json
  Bob:   recall "cats"    ──▶  empty ✅ (physically separate FactStore)
```

### How It Works

1. `createUserScopedMemoryProvider` is a `ComponentProvider` that reads `agent.pid.ownerId`
2. L1 sets `pid.ownerId` from `SessionContext.userId` at spawn time
3. Channel adapter (Telegram, Slack, etc.) sets `userId` in the session context
4. Each userId gets a dedicated `FsMemory` at `baseDir/users/<slugified-userId>/`
5. When no userId is present, falls back to shared memory at `baseDir/` (backward compat)

### LRU Cache

The cache holds `maxCachedUsers` (default: 100) `FsMemory` instances in memory. When the limit is exceeded, the least-recently-used instance is evicted — its summaries are rebuilt and data is flushed to disk. Re-accessing an evicted user creates a fresh `FsMemory` from the persisted data.

### Security

- All userIds are sanitized via `slugifyEntity()` (lowercase, alphanumeric + dash, max 64 chars)
- Path traversal attempts like `../admin` or `/etc/passwd` are stripped
- Unicode userIds (`用户42`) are slugified safely
- Empty userIds fall back to `_default`

### Context-Arena Integration (Zero Config)

When using `@koi/context-arena` (L3), per-user isolation and merge are wired automatically:

```typescript
const bundle = await createContextArena({
  summarizer: myModel,
  sessionId,
  getMessages: () => messages,
  memoryFs: {
    config: { baseDir: "/data/memory" },
    userScoped: true, // ← per-user isolation
    // merge auto-wired using summarizer (disable with disableMerge: true)
  },
});
```

---

## Namespace Filtering

Recall now respects the `namespace` option. When `options.namespace` is provided, only facts stored under that namespace are returned:

```typescript
await mem.component.store("project-x fact", { namespace: "project-x" });
await mem.component.store("project-y fact", { namespace: "project-y" });

await mem.component.recall("fact", { namespace: "project-x" });
// → only "project-x fact" (project-y filtered out)

await mem.component.recall("fact");
// → both facts (no filter, backward compat)
```

This works in both the retriever path and the fallback (recency) path. The namespace is slugified and matched against entity names.

---

## Composite Salience Scoring

Raw retriever scores (BM25/FTS) rank results by keyword overlap alone. A frequently-reinforced, recently-accessed fact with moderate keyword overlap loses to a barely-relevant fact that happens to match keywords better. Salience scoring fixes this by combining three signals into one ranking:

```
salience = similarity × log(accessCount + 2) × decayScore
```

| Signal | Source | Effect |
|--------|--------|--------|
| **similarity** | Retriever score, normalized to [0.1, 1.0] | Keyword/semantic relevance |
| **log(accessCount + 2)** | Reinforcement count from store/recall | Frequently-used facts rank higher |
| **decayScore** | Exponential decay from `lastAccessed` | Stale facts fade |

### Why `log(accessCount + 2)`?

- `+2` (not `+1`): `log(1) = 0` would zero out new facts. `log(2) ≈ 0.693` is a safe floor.
- `log` (not linear): Diminishing returns — going from 0→5 accesses matters more than 95→100. Prevents runaway dominance by high-access facts.
- 10 accesses gives `log(12) ≈ 2.5` — a ~3.6× boost over zero. Meaningful but not overwhelming.

### Why a Similarity Floor?

Min-max normalization maps the lowest-scored candidate to 0. Since salience is multiplicative, zero similarity silences access-count and decay entirely. A floor of 0.1 ensures the weakest retriever hit still carries its reinforcement and freshness signals:

```
Without floor: [10.0, 2.0] → [1.0, 0.0]  ← lowest fact always scores 0
With floor:    [10.0, 2.0] → [1.0, 0.1]  ← lowest fact preserves other signals
```

### Example

```
Two facts about TypeScript:

Fact A: "Alice prefers TypeScript"
  BM25: 3.2, accessCount: 8, age: 2 days
  → similarity: 0.1 (lowest BM25), log(10) ≈ 2.30, decay ≈ 0.95
  → salience: 0.1 × 2.30 × 0.95 ≈ 0.22

Fact B: "Team switched to TypeScript for the frontend"
  BM25: 8.7, accessCount: 0, age: 14 days
  → similarity: 1.0 (highest BM25), log(2) ≈ 0.69, decay ≈ 0.73
  → salience: 1.0 × 0.69 × 0.73 ≈ 0.50

Without salience: Fact B wins (raw BM25 8.7 > 3.2)
With salience:    Fact B still wins but the gap is smaller.
                  A few more accesses on Fact A would flip the ranking.
```

### Configuration

Salience is enabled by default. Opt out per-instance:

```typescript
const mem = await createFsMemory({
  baseDir: "/path/to/memory",
  salienceEnabled: false,  // raw score passthrough (pre-salience behavior)
});
```

### Performance

Pure math — one O(n) pass for min/max, one `Math.log` + two multiplies per candidate. For 20 candidates (the default 2× over-fetch), this adds ~microseconds — negligible vs retriever I/O.

### Interaction with Other Features

| Feature | Interaction |
|---------|-------------|
| **Hot-memory middleware** | Consumes salience-ranked results — gets better injection ordering for free |
| **Tier filtering** | Applied before salience — salience only ranks within the filtered set |
| **Graph expansion** | Applied before salience — expanded candidates' hop-decayed scores are the similarity input |
| **Reinforcement** | `store(content, { reinforce: true })` increments accessCount, boosting future salience |
| **Fallback (no retriever)** | All candidates score 1.0 → normalized to 1.0 (uniform) → salience = `log(accessCount + 2) × decay` |

---

## Disk Layout

```
baseDir/                                 (single-user / shared mode)
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

baseDir/                                 (user-scoped mode)
├── users/
│   ├── alice/                           ← per-user FsMemory root
│   │   ├── entities/
│   │   │   └── preference/items.json
│   │   └── sessions/
│   └── bob/                             ← per-user FsMemory root
│       ├── entities/
│       │   └── preference/items.json
│       └── sessions/
├── entities/                            ← shared fallback (no userId)
└── sessions/
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
  entityHopDecay: 0.5,            // cross-entity score decay per hop (default: 0.5)
  maxEntityHops: 1,               // max cross-entity traversal depth (default: 1)
  perEntityCap: 10,               // max cross-entity results per source entity (default: 10)
  retriever: customRetriever,     // optional: semantic search (DI)
  indexer: customIndexer,         // optional: search indexing (DI)
  categoryInferrer: inferrer,     // optional: auto-categorize when category omitted (DI)
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

230+ tests total across 19 test files:

| Test File | Count | What It Covers |
|-----------|-------|----------------|
| `slug.test.ts` | 13 | Path traversal, unicode, edge cases |
| `dedup.test.ts` | 14 | Jaccard similarity, CJK bigrams |
| `decay.test.ts` | 11 | Decay scoring, tier classification |
| `salience.test.ts` | 18 | Normalization (floor, uniform, empty), salience formula, batch scoring |
| `fact-store.test.ts` | 15 | Concurrent writes, corruption recovery, causal backward compat |
| `session-log.test.ts` | 5 | Daily log append |
| `summary.test.ts` | 7 | Summary generation with tier filtering |
| `graph-walk.test.ts` | 9 | BFS expansion, cycle detection, score decay, dedup |
| `entity-index.test.ts` | 11 | Reverse index: build, add, lookup, dedup, self-ref guard |
| `cross-entity.test.ts` | 17 | Cross-entity: decay, cap, cycles, hops, integration |
| `category-inferrer.test.ts` | 28 | Keyword rules (6 categories), fallback, case insensitivity, ordering, custom rules, custom fallback |
| `fs-memory.test.ts` | 38 | Full integration: store → recall → dedup → decay → causal → graph expansion → salience |
| `fs-memory-category.test.ts` | 6 | Category inference integration: infer, override, backward compat, async, error fallback, dedup |
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
