# @koi/middleware-collective-memory — Cross-Run Learning Persistence

Extracts reusable learnings from spawn-family tool results, persists them as collective memory on brick artifacts, and injects relevant learnings into future model calls. Agents get smarter across runs without manual prompt engineering.

---

## Why It Exists

Koi agents are stateless per-session: each `runtime.run()` starts with a blank context. Spawn-family tools (`task`, `parallel_task`, `delegate`) produce valuable insights — gotchas, corrections, patterns — but these learnings vanish when the session ends.

This middleware solves three problems:

1. **Cross-run learning** — discoveries from past sessions are automatically injected into future ones
2. **Self-improving agents** — without human intervention, agents accumulate domain knowledge over time
3. **Knowledge compaction** — stale/duplicate entries are pruned via exponential decay scoring, keeping memory lean

Without this package, every agent session starts from zero institutional knowledge.

---

## Architecture

`@koi/middleware-collective-memory` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0u utilities (`@koi/validation`, `@koi/token-estimator`). Zero external dependencies.

```
┌─────────────────────────────────────────────────────────────────┐
│  @koi/middleware-collective-memory  (L2)                         │
│                                                                  │
│  collective-memory-middleware.ts  ← middleware factory (core)    │
│  extract-learnings.ts            ← marker + heuristic extractor │
│  extract-llm.ts                  ← post-session LLM extraction  │
│  inject.ts                       ← format entries for injection │
│  compact.ts                      ← compaction trigger + wrapper │
│  index.ts                        ← public API surface           │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  Dependencies                                                    │
│                                                                  │
│  @koi/core             (L0)   KoiMiddleware, BrickArtifact,     │
│                                CollectiveMemory, ForgeStore      │
│  @koi/validation       (L0u)  compactEntries, deduplicateEntries,│
│                                selectEntriesWithinBudget          │
│  @koi/token-estimator  (L0u)  estimateTokens (chars/4)          │
└──────────────────────────────────────────────────────────────────┘
```

---

## How It Works

### Two-Way Data Flow

```
  Spawn tool completes (task / parallel_task / delegate)
       │
       ▼
  ┌──────────────────────┐
  │ wrapToolCall()       │  ← WRITE PATH
  │  extract learnings   │     1. Extract via markers + heuristics
  │  deduplicate         │     2. Jaccard dedup against existing entries
  │  persist to brick    │     3. Fire-and-forget ForgeStore.update()
  └──────┬───────────────┘
         │
  ───────┼────── (next session) ──────
         │
         ▼
  ┌──────────────────────┐
  │ wrapModelCall()      │  ← READ PATH
  │  load brick memory   │     1. Load CollectiveMemory from ForgeStore
  │  select within budget│     2. Priority-sort, fit to token budget
  │  prepend as system   │     3. Inject as system message (one-shot)
  └──────────────────────┘
         │
         ▼
  ┌──────────────────────┐
  │ onSessionEnd()       │  ← OPTIONAL LLM EXTRACTION
  │  accumulated outputs │     Run LLM over session outputs to find
  │  → LLM extraction    │     implicit learnings not caught by regex
  └──────────────────────┘
```

### Write Path (Learning Extraction)

Two complementary extraction mechanisms:

1. **Marker-based** (explicit, confidence 1.0): Workers emit `[LEARNING:category] content` markers in their output
2. **Heuristic-based** (implicit, confidence 0.7): Pattern matching on keywords like "avoid", "actually", "next time", "best practice"

Extracted entries are deduplicated against existing memory using Jaccard similarity (threshold 0.65) and persisted to the brick's `collectiveMemory` field via `ForgeStore.update()`. Persistence is fire-and-forget — failures never break tool chains.

### Read Path (Injection)

On the **first model call per session**, the middleware:

1. Resolves the brick ID from the session's agent name
2. Loads the brick artifact from ForgeStore
3. Sorts entries by priority (exponential decay: `accessCount × e^(-λ × age)`)
4. Selects entries within the injection token budget (default 3000)
5. Groups by category (gotchas → corrections → patterns → heuristics → preferences → context)
6. Prepends as a system message

Subsequent model calls in the same session skip injection (one-shot flag).

### Auto-Compaction

When `maxEntries` (50) or `maxTokens` (8000) thresholds are exceeded, the middleware runs a three-phase compaction pipeline:

1. **Prune** — remove entries with `accessCount === 0` older than `coldAgeDays` (30)
2. **Deduplicate** — Jaccard similarity merge (keep higher-priority entries)
3. **Trim** — drop lowest-priority entries to fit within limits

---

## API

### Factory

```typescript
function createCollectiveMemoryMiddleware(
  config: CollectiveMemoryMiddlewareConfig,
): KoiMiddleware
```

### Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `forgeStore` | `ForgeStore` | required | Brick persistence backend |
| `resolveBrickId` | `(name: string) => BrickId \| undefined` | required | Maps agent name → brick ID |
| `tokenEstimator` | `TokenEstimator` | chars/4 | Token counting strategy |
| `extractor` | `LearningExtractor` | default | Marker + heuristic extractor |
| `maxEntries` | `number` | `50` | Compaction entry threshold |
| `maxTokens` | `number` | `8000` | Compaction token threshold |
| `coldAgeDays` | `number` | `30` | Stale entry prune age |
| `injectionBudget` | `number` | `3000` | Token budget for injection |
| `dedupThreshold` | `number` | `0.65` | Jaccard similarity threshold |
| `autoCompact` | `boolean` | `true` | Auto-trigger compaction |
| `modelCall` | `(req) => Promise<string>` | `undefined` | LLM for post-session extraction |

### Middleware Properties

| Property | Value |
|----------|-------|
| `name` | `"collective-memory-middleware"` |
| `priority` | `305` |
| Hooks | `wrapToolCall`, `wrapModelCall`, `onSessionStart`, `onSessionEnd` |

### Learning Categories

| Category | Purpose | Example |
|----------|---------|---------|
| `gotcha` | Pitfalls, common mistakes | "API returns 404 not 403 for unauthorized" |
| `correction` | Corrected misconceptions | "Actually uses UTC timestamps, not local" |
| `pattern` | Reusable techniques | "Always batch Redis calls in pipeline" |
| `heuristic` | Rules of thumb | "Keep Lambda cold start under 3s" |
| `preference` | Style/approach preferences | "Team prefers explicit error returns over throws" |
| `context` | Domain knowledge | "Production DB has 2M users, 50M events" |

---

## Usage

### 1. Standalone Middleware

```typescript
import { createCollectiveMemoryMiddleware } from "@koi/middleware-collective-memory";

const middleware = createCollectiveMemoryMiddleware({
  forgeStore: myForgeStore,
  resolveBrickId: (name) => brickRegistry.get(name),
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [middleware],
});
```

### 2. With @koi/autonomous (Recommended)

```typescript
import { createAutonomousAgent } from "@koi/autonomous";
import { createCollectiveMemoryMiddleware } from "@koi/middleware-collective-memory";

const agent = createAutonomousAgent({
  harness,
  scheduler,
  collectiveMemoryMiddleware: createCollectiveMemoryMiddleware({
    forgeStore: myForgeStore,
    resolveBrickId: (name) => brickRegistry.get(name),
  }),
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [...agent.middleware()], // includes collective-memory at priority 305
});
```

### 3. With LLM Post-Session Extraction

```typescript
const middleware = createCollectiveMemoryMiddleware({
  forgeStore,
  resolveBrickId: (name) => brickRegistry.get(name),
  modelCall: async (req) => {
    const response = await callHaiku(req);
    return response.text;
  },
});
```

### 4. Worker-Side Marker Emission

Workers can explicitly emit learnings for higher-confidence extraction:

```
[LEARNING:gotcha] The staging API rate-limits at 10 req/s, not 100 as documented
[LEARNING:pattern] Use batch endpoint for >5 items — 3x faster than individual calls
[LEARNING:correction] Config file is YAML not JSON despite .json extension
```

---

## Algorithms

### Priority Scoring (Exponential Decay)

```
priority = accessCount × e^(-λ × ageDays)
λ = ln(2) / halfLifeDays    (halfLifeDays = 7)
```

- New entries (accessCount = 0) get base weight of 1 for initial surfacing
- Frequently accessed + recent entries score highest
- Entries unused for 2+ weeks naturally decay below the selection threshold

### Jaccard Similarity (Deduplication)

```
J(A, B) = |A ∩ B| / |A ∪ B|
```

Word-set tokenization (lowercase, whitespace-split). Entries with `J ≥ 0.65` are considered duplicates; the higher-priority one is kept.

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Fire-and-forget persistence | Learning extraction must never break tool chains or slow model calls |
| One-shot injection per session | Prevents context bloat from repeated injection across model calls |
| Marker + heuristic dual extraction | Explicit markers catch known insights; heuristics catch implicit patterns |
| Post-session LLM extraction (optional) | Catches subtle learnings that regex misses, at the cost of one LLM call |
| Priority 305 | After context hydrator (300), before hot-memory (310) |
| Exponential decay scoring | Naturally surfaces recent + frequently-used entries without manual curation |
| CAS conflict retry | Handles concurrent writes with single retry on generation mismatch |

---

## Layer Compliance

```
@koi/core (L0)
    ▲
    │  types only: CollectiveMemory, BrickArtifact, KoiMiddleware
    │
@koi/validation (L0u)  ◄── pure algorithms: dedup, prune, compact
@koi/token-estimator (L0u) ◄── token counting
    ▲
    │
@koi/middleware-collective-memory (L2)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```

---

## Testing

```bash
bun test packages/mm/middleware-collective-memory/
```

| File | Tests | Focus |
|------|-------|-------|
| `collective-memory-middleware.test.ts` | 21 suites | Write/read paths, resilience, session lifecycle |
| `extract-learnings.test.ts` | 10+ | Marker + heuristic extraction |
| `extract-llm.test.ts` | 10+ | LLM prompt building + response parsing |
| `inject.test.ts` | 8 | Category grouping, budget selection |
| `compact.test.ts` | 8 | Threshold detection, compaction pipeline |

**74 tests total, 96.5% coverage.**
