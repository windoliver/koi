# Memory Tiering — Decay-Based Memory Prioritization (L0)

Hot/warm/cold classification and decay scoring for agent memory, exposed through the L0 `MemoryComponent` contract. Backends that support tiering (Nexus, SQLite) populate these fields; backends that don't (in-memory) leave them `undefined`. Zero breaking changes — all fields are optional.

---

## Why It Exists

Without tiering, agent memory is a flat bag of strings. The agent can't tell fresh knowledge from stale noise:

```
Without Tiering                        With Tiering
───────────────                        ────────────

recall("user prefs")                   recall("user prefs", { tierFilter: "hot" })
  → 200 results, all equal               → 5 results, all recently accessed
  → no way to rank by freshness          → each result carries tier + decayScore
  → stale facts crowd out fresh ones      → cold memories filtered out automatically

store("likes dark mode")               store("likes dark mode", {
  → flat text, no classification           category: "preference",
  → no entity linking                      relatedEntities: ["user-42"],
                                         })
                                         → classified for graph-aware retrieval
```

Three systems benefit from tiered memory:

| Consumer | What it does with tier data |
|----------|---------------------------|
| **Recall filtering** | `tierFilter: "hot"` returns only fresh, high-value memories — reduces context injection noise |
| **Decay engine (L2)** | Reads `decayScore` + `lastAccessed` to promote/demote memories between tiers over time |
| **Graph retrieval (L2)** | `relatedEntities` enables "what do I know about entity X?" queries across categories |

---

## Layer Position

```
L0  @koi/core
    └── MemoryTier                   ← "hot" | "warm" | "cold"
        MemoryResult                 ← extended: + tier?, decayScore?, lastAccessed?
        MemoryRecallOptions          ← extended: + tierFilter?, limit?
        MemoryStoreOptions           ← extended: + category?, relatedEntities?
        MemoryComponent              ← unchanged contract (recall + store)
        MEMORY                       ← unchanged singleton token

L2  @koi/middleware-memory (existing)
    └── MemoryMiddleware             ← wrapModelCall injection
    └── createInMemoryStore()        ← ignores tier fields (backward compat)

L2  @koi/memory-nexus (future, #195)
    └── implements MemoryComponent
    └── Nexus backend — populates tier, decayScore, lastAccessed
    └── supports tierFilter on recall

L2  @koi/memory-sqlite (future)
    └── implements MemoryComponent
    └── SQLite backend with decay engine
```

`@koi/core` has zero dependencies. The memory types import nothing from other `@koi/*` packages — no vendor types, no framework concepts.

---

## Architecture

### What changed in the L0 contract

The `MemoryComponent` interface itself is unchanged — `recall()` and `store()` have the same signatures. Only the option and result shapes are extended with optional fields:

```
MemoryComponent (unchanged)
│
├── recall(query, options?) → MemoryResult[]
│   │
│   ├── options gained:
│   │   ├── tierFilter?   "hot" | "warm" | "cold" | "all"
│   │   └── limit?        number
│   │
│   └── results gained:
│       ├── tier?          "hot" | "warm" | "cold"
│       ├── decayScore?    number [0.0, 1.0]
│       └── lastAccessed?  string (ISO-8601)
│
└── store(content, options?) → void
    │
    └── options gained:
        ├── category?         string
        └── relatedEntities?  readonly string[]
```

### Backward compatibility

Every new field is optional (`?`). Existing code compiles without changes:

```
Existing code (still works):           New code (uses tier fields):

const results = await mem.recall(q);   const results = await mem.recall(q, {
// results[0].content ← always there    tierFilter: "hot",
// results[0].tier   ← undefined         limit: 10,
                                        });
                                        // results[0].tier  ← "hot"
                                        // results[0].decayScore ← 0.95

await mem.store("fact", {              await mem.store("fact", {
  namespace: "research",                 namespace: "research",
  tags: ["important"],                   tags: ["important"],
});                                      category: "milestone",
                                         relatedEntities: ["project-7"],
                                        });
```

---

## Data Flow

### Recall with tier filtering

```
  Agent needs fresh context:
      │
      ▼
  recall("user preferences", {
    tierFilter: "hot",
    limit: 5,
  })
      │
      ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  MemoryComponent (L2 backend)                                │
  │                                                              │
  │  All stored memories:                                        │
  │                                                              │
  │  ┌─────────────────────────────────────────────────────────┐ │
  │  │  HOT   "User prefers dark mode"   decay=0.98  2min ago │ │  ← returned
  │  │  HOT   "Uses TypeScript daily"    decay=0.95  5min ago │ │  ← returned
  │  │  WARM  "Tried Rust last month"    decay=0.55  2hr ago  │ │  ← filtered out
  │  │  COLD  "Used jQuery in 2015"      decay=0.08  90d ago  │ │  ← filtered out
  │  └─────────────────────────────────────────────────────────┘ │
  │                                                              │
  │  Apply: tierFilter="hot", limit=5                            │
  └──────────────────────────────────────────────────────────────┘
      │
      ▼
  Returns 2 MemoryResult objects:
  [
    { content: "User prefers dark mode", tier: "hot", decayScore: 0.98,
      lastAccessed: "2026-02-26T10:58:00Z", score: 0.95 },
    { content: "Uses TypeScript daily",  tier: "hot", decayScore: 0.95,
      lastAccessed: "2026-02-26T10:55:00Z", score: 0.90 },
  ]
```

### Store with category and entity linking

```
  Agent learns a new fact:
      │
      ▼
  store("User completed onboarding", {
    namespace: "events",
    tags: ["milestone"],
    category: "milestone",
    relatedEntities: ["user-42", "project-7"],
  })
      │
      ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  MemoryComponent (L2 backend)                                │
  │                                                              │
  │  Stores with metadata:                                       │
  │  ┌─────────────────────────────────────────────────────────┐ │
  │  │  content:  "User completed onboarding"                  │ │
  │  │  tier:     HOT  (new memories start hot)                │ │
  │  │  decay:    1.0  (freshly stored)                        │ │
  │  │  category: "milestone"                                  │ │
  │  │  entities: ["user-42", "project-7"]                     │ │
  │  └─────────────────────────────────────────────────────────┘ │
  │                                                              │
  │  Later query: "What do I know about user-42?"                │
  │  → Backend matches relatedEntities → returns this memory     │
  └──────────────────────────────────────────────────────────────┘
```

### Decay lifecycle

```
  ┌──────────────────────────────────────────────────────────────┐
  │                     DECAY LIFECYCLE                          │
  │                                                              │
  │  Time        Tier     Decay    Event                         │
  │  ──────────  ───────  ──────   ─────────────────────────     │
  │  t=0         HOT      1.00    Stored — starts hot            │
  │  t=1h        HOT      0.95    Accessed — stays hot           │
  │  t=1d        WARM     0.65    Not accessed — demoted         │
  │  t=7d        WARM     0.40    Still relevant but cooling     │
  │  t=30d       COLD     0.12    Rarely accessed                │
  │  t=90d       COLD     0.01    Candidate for eviction         │
  │                                                              │
  │  Access resets decay:                                        │
  │  t=31d       HOT      1.00    Recalled! → promoted to hot   │
  │  t=32d       HOT      0.95    Still fresh after promotion    │
  │                                                              │
  │  Decay function (L2 responsibility):                         │
  │  decayScore = e^(-λ * hoursSinceLastAccess)                  │
  │  where λ is the decay rate (backend-configurable)            │
  │                                                              │
  │  Tier thresholds (L2 responsibility):                        │
  │    HOT:   decayScore ≥ 0.7                                   │
  │    WARM:  0.3 ≤ decayScore < 0.7                             │
  │    COLD:  decayScore < 0.3                                   │
  └──────────────────────────────────────────────────────────────┘
```

---

## MemoryTier

Three temperature tiers, from most to least valuable in context:

```
MemoryTier = "hot" | "warm" | "cold"

  HOT    Recently accessed, high decay score.
         Actively relevant to current conversations.
         Injected into context by default.

  WARM   Not recently accessed but not fully decayed.
         Relevant for broader context or follow-up questions.
         Injected on request (tierFilter: "warm" or omitted).

  COLD   Long-untouched memories with low decay scores.
         Archived knowledge — rarely injected into context.
         Candidates for eviction or compression.
```

The tier is computed by L2 backends based on `decayScore` thresholds. L0 defines only the vocabulary — no tier boundary logic.

---

## API Reference

### Types

| Export | Kind | Description |
|--------|------|-------------|
| `MemoryTier` | type | `"hot" \| "warm" \| "cold"` — temperature tier |
| `MemoryResult` | interface | Recall output — extended with `tier?`, `decayScore?`, `lastAccessed?` |
| `MemoryRecallOptions` | interface | Recall input — extended with `tierFilter?`, `limit?` |
| `MemoryStoreOptions` | interface | Store input — extended with `category?`, `relatedEntities?` |
| `MemoryComponent` | interface | Unchanged — `recall()` + `store()` |

### MemoryResult fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | `string` | yes | The memory text content |
| `score` | `number` | no | Relevance score from vector/semantic search |
| `metadata` | `Record<string, unknown>` | no | Arbitrary backend metadata |
| `tier` | `MemoryTier` | no | Temperature tier — backends that support tiering populate this |
| `decayScore` | `number` | no | Decay factor in [0.0, 1.0] — 1.0 = fully fresh, 0.0 = fully decayed |
| `lastAccessed` | `string` | no | ISO-8601 timestamp of last access |

### MemoryRecallOptions fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `namespace` | `string` | no | Namespace isolation (pre-existing) |
| `tierFilter` | `MemoryTier \| "all"` | no | Filter by tier. Omit or `"all"` for no filtering |
| `limit` | `number` | no | Max results. Backend-specific default if omitted |

### MemoryStoreOptions fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `namespace` | `string` | no | Namespace isolation (pre-existing) |
| `tags` | `readonly string[]` | no | Semantic tags (pre-existing) |
| `category` | `string` | no | Fact classification (e.g., `"milestone"`, `"preference"`, `"relationship"`) |
| `relatedEntities` | `readonly string[]` | no | Entity IDs for graph-aware retrieval |

### Runtime values

| Export | Type | Description |
|--------|------|-------------|
| `MEMORY` | `SubsystemToken<MemoryComponent>` | Singleton token (unchanged) |

---

## Implementing a Backend

### Minimal implementation (ignores tier fields)

Existing backends need zero changes — all new fields are optional:

```typescript
import type { MemoryComponent } from "@koi/core";

const backend: MemoryComponent = {
  recall: async (query, options) => {
    // tierFilter and limit are available but can be ignored
    return [{ content: "some memory", score: 0.8 }];
    // tier, decayScore, lastAccessed are undefined — callers handle this
  },

  store: async (content, options) => {
    // category and relatedEntities are available but can be ignored
    // store content with namespace and tags as before
  },
};
```

### Tier-aware implementation

```typescript
import type { MemoryComponent, MemoryTier } from "@koi/core";

function computeTier(decayScore: number): MemoryTier {
  if (decayScore >= 0.7) return "hot";
  if (decayScore >= 0.3) return "warm";
  return "cold";
}

function computeDecay(lastAccessedMs: number, now: number): number {
  const hoursSince = (now - lastAccessedMs) / 3_600_000;
  const LAMBDA = 0.01; // decay rate — tune per use case
  return Math.exp(-LAMBDA * hoursSince);
}

const backend: MemoryComponent = {
  recall: async (query, options) => {
    const now = Date.now();
    let results = searchByVector(query); // your vector search

    // Compute decay for each result
    results = results.map((r) => {
      const decay = computeDecay(r.lastAccessedMs, now);
      const tier = computeTier(decay);
      return {
        content: r.content,
        score: r.score,
        tier,
        decayScore: decay,
        lastAccessed: new Date(r.lastAccessedMs).toISOString(),
      };
    });

    // Apply tier filter
    if (options?.tierFilter && options.tierFilter !== "all") {
      results = results.filter((r) => r.tier === options.tierFilter);
    }

    // Apply limit
    if (options?.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  },

  store: async (content, options) => {
    await insertMemory({
      content,
      namespace: options?.namespace,
      tags: options?.tags,
      category: options?.category,
      relatedEntities: options?.relatedEntities,
      lastAccessedMs: Date.now(),
    });
  },
};
```

---

## Comparison: Memory Approaches in Agent Systems

| Dimension | Flat memory (before) | Koi tiered memory (after) | MemoryOS (2025) | MemGPT |
|-----------|---------------------|--------------------------|-----------------|--------|
| Tier model | None | Hot / Warm / Cold | Short / Mid / Long | Main / External |
| Decay | None | Exponential, backend-configurable | Eligibility threshold | LRU eviction |
| Filtering | Namespace only | Namespace + tier + limit | Utility pruning | Page management |
| Entity linking | None | `relatedEntities` | Feature vectors | None |
| Classification | None | `category` field | Structure selection | None |
| L0 contract | Yes | Yes (extended) | N/A (monolith) | N/A (monolith) |
| Backend-agnostic | Yes | Yes | No | No |

---

## Testing

### Type and structural tests

```bash
bun test packages/core/src/__tests__/types.test.ts
```

Covers: `MemoryTier` valid literals, compile-time rejection of invalid values, `MemoryResult` with and without tier fields, `MemoryRecallOptions` with `tierFilter`/`limit`, `MemoryStoreOptions` with `category`/`relatedEntities`, backward compatibility (all old shapes still compile).

### Export inventory

```bash
bun test packages/core/src/__tests__/exports.test.ts
```

Compile-time regression guard — fails if `MemoryTier`, `MemoryRecallOptions`, `MemoryStoreOptions`, or `MemoryResult` are accidentally removed from exports.

### API surface snapshot

```bash
bun test packages/core/src/__tests__/api-surface.test.ts
```

Snapshots the `.d.ts` output — any unintended signature change causes a diff.

---

## Related Issues

| Issue | Package | Relationship |
|-------|---------|-------------|
| **#455** | `@koi/core` | This change — L0 type additions |
| **#195** | `@koi/memory-nexus` | Blocked by #455 — needs tier/decay fields on results |
| **#24** | `@koi/entity-memory` | Related — entity-scoped memory uses `relatedEntities` |
| **#327** | `@koi/knowledge-vault` | Related — long-term knowledge uses `category` classification |
