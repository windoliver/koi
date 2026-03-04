# @koi/context-arena — Coordinated Context Window Management

Arena allocator for the context window: a single `createContextArena()` factory allocates token budgets across all 7 context management packages with coherent preset-driven profiles (conservative / balanced / aggressive). Three required fields, one function call, and every middleware gets coordinated thresholds.

---

## Why It Exists

Koi's context management is spread across 7 independent L2 packages. Each has its own defaults, and without coordination:

1. **Budget collisions** — the compactor's trigger threshold doesn't account for context-editing's trigger. Both can fire at the same time, wasting an expensive LLM summarization call when a cheap tool-result trim would have sufficed.
2. **Manual tuning** — users must understand 8+ numeric parameters across 3 packages, calculate token fractions by hand, and hope the values are coherent.
3. **Inconsistent defaults** — each L2 package's defaults were designed in isolation. A `preserveRecent: 4` in one package and `preserveRecent: 6` in another creates asymmetric behavior.

Without this package:
- Users must manually configure and wire 3-7 middleware + providers
- Budget parameters conflict (editing fires after compactor instead of before)
- No single place to reason about the full context management stack
- Adding a new context feature requires touching multiple configuration sites

---

## Architecture

`@koi/context-arena` is an **L3 meta-package** — it re-exports nothing from L0/L1 and adds no new logic beyond coordination. It imports from L0 (`@koi/core`) and L2 feature packages.

```
┌──────────────────────────────────────────────────────────┐
│  @koi/context-arena  (L3)                                 │
│                                                           │
│  types.ts              ← config, bundle, preset types     │
│  presets.ts            ← PRESET_SPECS + computePresetBudget│
│  config-resolution.ts  ← resolveContextArenaConfig()      │
│  arena-factory.ts      ← createContextArena() async factory│
│  registry-adapter.ts   ← createContextArenaEntries() for  │
│                          @koi/starter manifest resolution  │
│  index.ts              ← public API surface                │
│                                                           │
├───────────────────────────────────────────────────────────┤
│  Dependencies                                             │
│                                                           │
│  @koi/core                    (L0)   Types, interfaces    │
│  @koi/context                 (L2)   Context hydrator     │
│  @koi/memory-fs               (L2)   Filesystem memory    │
│  @koi/middleware-compactor     (L2)   Compaction middleware│
│  @koi/middleware-context-editing (L2) Context editing MW   │
│  @koi/middleware-conversation  (L2)   Thread history MW    │
│  @koi/snapshot-chain-store    (L0u)  Archive store        │
│  @koi/token-estimator         (L2)   Heuristic estimator  │
│  @koi/tool-squash             (L2)   Agent-initiated squash│
└───────────────────────────────────────────────────────────┘
```

---

## What This Enables

```
BEFORE: Manual wiring (7 packages, 15+ config fields)
═══════════════════════════════════════════════════════

import { createCompactorMiddleware } from "@koi/middleware-compactor";
import { createContextEditingMiddleware } from "@koi/middleware-context-editing";
import { createSquashProvider } from "@koi/tool-squash";
import { createFsMemory, createMemoryProvider } from "@koi/memory-fs";
import { createContextHydrator } from "@koi/context";
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";

// Manual budget calculation
const windowSize = 200_000;
const tokenEstimator = HEURISTIC_ESTIMATOR;

const squash = createSquashProvider({
  archiver, sessionId, tokenEstimator,
  preserveRecent: 4,            // ← guess
  maxPendingSquashes: 3,        // ← guess
}, getMessages);

const compactor = createCompactorMiddleware({
  summarizer, contextWindowSize: windowSize, tokenEstimator,
  trigger: { tokenFraction: 0.6, softTriggerFraction: 0.5 },  // ← hope these
  preserveRecent: 4,                                            //   don't clash
  maxSummaryTokens: 1000,                                       //   with above
});

const editing = createContextEditingMiddleware({
  triggerTokenCount: 100_000,   // ← must be < compactor trigger
  numRecentToKeep: 3,
  tokenEstimator,
});

// Wire manually...
middleware: [squash.middleware, compactor, editing]
providers: [squash.provider]


AFTER: Arena allocator (3 required fields, 1 function call)
══════════════════════════════════════════════════════════════

import { createContextArena } from "@koi/context-arena";

const bundle = await createContextArena({
  summarizer: myModelHandler,
  sessionId: mySessionId,
  getMessages: () => messages,
  // preset: "balanced",      ← optional, this is the default
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [...bundle.middleware, ...otherMiddleware],
  providers: [...bundle.providers],
});
```

---

## How It Works

### Config Resolution Pipeline

```
  User Config                      Preset Budget              Resolved Config
  ───────────                      ─────────────              ───────────────

  {                         computePresetBudget()
    summarizer ─────────┐   ┌─────────────────┐     ┌─────────────────────────┐
    sessionId ──────────┤   │ "balanced" @200K │     │ preset: "balanced"      │
    getMessages ────────┤   │                  │     │ contextWindowSize: 200K │
    preset? ────────────┼──▶│ compactor: 60%   │────▶│ compactorTrigger: 0.60  │
    contextWindowSize? ─┤   │ editing: 100K    │     │ editingTrigger: 100K    │
    compactor? ─────────┼─┐ │ squash: 4 recent │     │ squashRecent: 4         │
    contextEditing? ────┼─┤ │ ...              │     │ ...                     │
    squash? ────────────┘ │ └─────────────────┘     └─────────────────────────┘
                          │          ▲                          ▲
                          │          │                          │
                          └──────────┴──────────────────────────┘
                              User overrides WIN over preset
```

Three-layer merge: L2 defaults (internal to L2 factories) → preset budget → user overrides. The arena only configures values it coordinates — L2 factories handle their own internal defaults.

### Bundle Assembly

```
  createContextArena(config)
         │
         ▼
  ┌─────────────────────────────────┐
  │ 1. resolveContextArenaConfig()  │
  │    preset + window → budgets    │
  └──────────────┬──────────────────┘
                 │
    ┌────────────┼────────────┬──────────────────┐
    ▼            ▼            ▼                  ▼
  squash      compactor   context-editing    (optional)
  provider +  middleware  middleware          memoryFs
  middleware                                 hydrator
    │            │            │                  │
    ▼            ▼            ▼                  ▼
  ┌─────────────────────────────────────────────────────┐
  │ ContextArenaBundle                                   │
  │                                                      │
  │ middleware: [conversation(100)?, squash(220),           │
  │             compactor(225), editing(250)]              │
  │ providers:  [squash, memoryFs?]                       │
  │ config:     ResolvedContextArenaConfig                │
  │ createHydrator?: (agent) => ContextHydratorMiddleware │
  └─────────────────────────────────────────────────────┘
```

All middleware receive the **same tokenEstimator instance**, ensuring consistent token counting across the stack.

### Middleware Stack (Priority Order)

```
Priority  Middleware              Package                          Trigger
────────  ──────────              ───────                          ───────
  100     conversation (opt-in)   @koi/middleware-conversation    Session start (loads thread history)
  220     squash                  @koi/tool-squash                Agent calls squash() tool
  225     compactor               @koi/middleware-compactor       tokenFraction threshold (LLM call)
  250     context-editing         @koi/middleware-context-editing triggerTokenCount threshold
  300     context-hydrator        @koi/context                   Session start (pre-loads context)
```

Cascade behavior: conversation (100) loads thread history within token budget → squash (220) fires first → reduces context → compactor (225) may skip if below threshold → context-editing (250) clears remaining stale tool results. Self-limiting by design.

Key invariant: **editing trigger < compactor trigger** — editing clears stale tool results (cheap, no LLM call) before compaction fires (expensive LLM summarization).

### Memory Wiring

When `memoryFs` is enabled, facts extracted during squash and compaction are persisted to the filesystem memory store. The arena creates a single `FsMemory` instance and shares it across all consumers:

```
  createContextArena(config)
         │
         ▼
  ┌──────────────────────────────────┐
  │ 1. Create FsMemory (if memoryFs)│
  │    fsMemory = createFsMemory()   │
  └──────────────┬───────────────────┘
                 │
  ┌──────────────┴──────────────────┐
  │ 2. Compute effectiveMemory      │
  │    config.memory ?? fsMemory?.component │
  └──────────────┬──────────────────┘
                 │
    ┌────────────┼────────────┐
    ▼            ▼            ▼
  squash      compactor    memoryProvider
  (memory:    (memory:     (memory:
   effective)  effective)   fsMemory)
    │            │            │
    │            │            └──► recall/search/store tools
    │            └──────────────► fact extraction during compaction
    └───────────────────────────► fact extraction during squash
```

**Override precedence:** `config.memory` takes priority over `fsMemory.component` for fact extraction. When both are provided, the explicit `memory` is used for squash + compactor, while `memoryFs` tools (recall, search, store) still attach to the agent.

**Single instance guarantee:** `createFsMemory()` is called exactly once. The same `FsMemory` instance is shared between the memory provider (which exposes tools) and the squash/compactor middleware (which extract facts). No duplicate file handles or inconsistent state.

### Compactor Archiver Wiring

The arena automatically wires a durable archiver for the compactor so that original messages are preserved before summarization:

```
resolved.archiver (SnapshotChainStore)
        │
        ▼
  createSnapshotArchiver(store, { sessionId })
        │
        ├──► without memory: snapshotArchiver used directly
        │
        └──► with memory: createCompositeArchiver([
                 snapshotArchiver,           ← raw message preservation
                 factExtractingArchiver,     ← semantic fact extraction
             ])
```

The snapshot archiver writes to chain `compact:{sessionId}` (namespace-separated from squash's `squash:{sessionId}`). Both chains share the same `SnapshotChainStore` instance but track independent histories. On store errors, the archiver throws so `compact.ts`'s existing try/catch can log the failure.

### Search Wiring (retriever / indexer)

The `memoryFs` wrapper exposes optional `retriever` and `indexer` slots for semantic search injection. These are the standard DI points for plugging in embedding-based search:

```
  memoryFs: {
    config: { baseDir }
    retriever? ──► FsSearchRetriever  (semantic recall)
    indexer?   ──► FsSearchIndexer    (auto-index on store)
  }
```

**Override precedence:** Wrapper-level values override `config.retriever` / `config.indexer` via nullish coalescing (`??`). This means you can set defaults inside `FsMemoryConfig` and override at the arena level without clobbering:

```
  wrapper.retriever ?? config.retriever
  wrapper.indexer   ?? config.indexer
```

**Why this matters:** Without these slots, search injection required constructing the full `FsMemoryConfig` with retriever/indexer buried inside — undiscoverable and not composable at the L3 wiring path. Lifting them to the wrapper makes search a first-class, visible DI point.

**Re-exported types:** `FsSearchRetriever`, `FsSearchIndexer`, `FsSearchHit`, and `FsIndexDoc` are re-exported from `@koi/context-arena` so adapter authors import from one place.

```typescript
import type {
  FsSearchRetriever,
  FsSearchIndexer,
  FsSearchHit,
  FsIndexDoc,
} from "@koi/context-arena";
```

---

## Presets

Three named budget profiles that allocate the context window:

| Field | Conservative | Balanced | Aggressive |
|-------|-------------|----------|------------|
| Compactor trigger | 50% | 60% | 75% |
| Soft trigger | 40% | 50% | 65% |
| Editing trigger | 40% | 50% | 60% |
| Preserve recent | 6 | 4 | 3 |
| Summary token fraction | 0.5% | 0.5% | 0.75% |
| Editing recent to keep | 4 | 3 | 2 |
| Max pending squashes | 2 | 3 | 4 |
| Conversation history | 2% | 3% | 5% |

### At 200K Context Window

```
Conservative (safe, compact early)
0%──────────40%──────50%──────────────────────────────100%
             ▲        ▲
          editing   compactor
          (80K)     (100K)
◄── room ──►◄─ gap ─►
   to work    20K buffer

Balanced (default, Goldilocks zone)
0%────────────────50%──────60%────────────────────────100%
                   ▲        ▲
                editing   compactor
                (100K)    (120K)
◄─── room ──────►◄─ gap ─►
     to work      20K buffer

Aggressive (max context usage)
0%──────────────────────60%──────75%───────────────────100%
                         ▲        ▲
                      editing   compactor
                      (120K)    (150K)
◄──── room ────────────►◄─ gap ─►
       to work           30K buffer
```

---

## API Reference

### `createContextArena(config: ContextArenaConfig): Promise<ContextArenaBundle>`

Main factory. Async because optional `FsMemory` initialization requires I/O.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `summarizer` | `ModelHandler` | LLM handler for compaction summaries |
| `sessionId` | `SessionId` | Session ID for archive chain naming |
| `getMessages` | `() => readonly InboundMessage[]` | Returns current conversation messages |

**Optional fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `preset` | `ContextArenaPreset` | `"balanced"` | Budget profile |
| `contextWindowSize` | `number` | `200_000` | Context window in tokens |
| `tokenEstimator` | `TokenEstimator` | `HEURISTIC_ESTIMATOR` | Shared token estimator |
| `memory` | `MemoryComponent` | `undefined` | Fact extraction target (squash + compactor). Overrides `memoryFs` for extraction when both provided |
| `archiver` | `SnapshotChainStore` | In-memory store | Snapshot archive |
| `pruningPolicy` | `PruningPolicy` | `undefined` | Archive pruning |
| `compactor` | `CompactorOverrides` | — | Override compactor settings |
| `contextEditing` | `ContextEditingOverrides` | — | Override editing settings |
| `squash` | `SquashOverrides` | — | Override squash settings |
| `threadStore` | `ThreadStore` | `undefined` | Thread store for conversation history. Gates conversation middleware |
| `conversation` | `ConversationOverrides` | — | Override conversation settings (maxHistoryTokens, maxMessages, etc.) |
| `hydrator` | `{ config: ContextManifestConfig }` | — | Enable context hydrator |
| `memoryFs` | `{ config, retriever?, indexer? }` | — | Enable filesystem memory with optional search DI |

### `resolveContextArenaConfig(config: ContextArenaConfig): ResolvedContextArenaConfig`

Pure function. Merges preset + overrides into a fully-specified config. Useful for testing or inspecting resolved values without creating middleware.

### `computePresetBudget(preset: ContextArenaPreset, contextWindowSize: number): PresetBudget`

Derives absolute token budgets from a preset name and window size.

### `createContextArenaEntries(baseConfig): { entries, getBundle }`

Registry adapter for `@koi/starter`'s manifest-driven middleware resolution. Returns a map with a single `"context-arena"` entry. After the factory is called, `getBundle()` returns the full `ContextArenaBundle`.

### Key Types

```typescript
type ContextArenaPreset = "conservative" | "balanced" | "aggressive";

interface ContextArenaBundle {
  readonly middleware: readonly KoiMiddleware[];  // [conversation?, squash, compactor, editing]
  readonly providers: readonly ComponentProvider[];
  readonly config: ResolvedContextArenaConfig;
  readonly createHydrator?: (agent: Agent) => ContextHydratorMiddleware;
}
```

---

## Examples

### Basic: Arena with defaults

```typescript
import { createContextArena } from "@koi/context-arena";

const bundle = await createContextArena({
  summarizer: modelCall,
  sessionId: mySessionId,
  getMessages: () => messages,
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [...bundle.middleware],
  providers: [...bundle.providers],
});
```

### Conservative preset with custom window size

```typescript
const bundle = await createContextArena({
  summarizer: modelCall,
  sessionId,
  getMessages: () => messages,
  preset: "conservative",
  contextWindowSize: 128_000,
});
```

### With conversation history (thread continuity)

```typescript
import { createContextArena } from "@koi/context-arena";

const bundle = await createContextArena({
  summarizer: modelCall,
  sessionId,
  getMessages: () => messages,
  threadStore: myThreadStore,  // gates conversation middleware
  conversation: {
    maxHistoryTokens: 10_000, // override preset budget
    maxMessages: 100,
  },
});
// bundle.middleware now includes conversation (100) before squash (220)
```

### With per-package overrides

```typescript
const bundle = await createContextArena({
  summarizer: modelCall,
  sessionId,
  getMessages: () => messages,
  preset: "balanced",
  compactor: {
    trigger: { tokenFraction: 0.65 },  // override just this
    preserveRecent: 6,
  },
  contextEditing: {
    triggerTokenCount: 80_000,
  },
});
```

### With semantic search (retriever + indexer)

```typescript
import { createContextArena } from "@koi/context-arena";
import type { FsSearchRetriever, FsSearchIndexer } from "@koi/context-arena";

// Adapter-provided search implementations
const retriever: FsSearchRetriever = {
  retrieve: async (query, limit) => embedSearch(query, limit),
};
const indexer: FsSearchIndexer = {
  index: async (docs) => embedIndex(docs),
  remove: async (ids) => embedRemove(ids),
};

const bundle = await createContextArena({
  summarizer: modelCall,
  sessionId,
  getMessages: () => messages,
  memoryFs: {
    config: { baseDir: "/data/agent-memory" },
    retriever,  // semantic recall on memory.recall()
    indexer,    // auto-index facts on memory.store()
  },
});
```

### With optional modules (hydrator + memory-fs)

```typescript
const bundle = await createContextArena({
  summarizer: modelCall,
  sessionId,
  getMessages: () => messages,
  hydrator: {
    config: { sources: [{ type: "file", path: "./context.md" }] },
  },
  memoryFs: {
    config: { baseDir: "/tmp/agent-memory" },
  },
});

// Hydrator is a deferred factory — Agent needed at creation time
const runtime = await createKoi({ manifest, adapter, ... });
const hydrator = bundle.createHydrator?.(agent);
```

### With @koi/starter registry

```typescript
import { createContextArenaEntries } from "@koi/context-arena";

const { entries, getBundle } = createContextArenaEntries({
  summarizer: modelCall,
  sessionId,
  getMessages: () => messages,
});

// Register with middleware registry
// Manifest can set: { options: { preset: "aggressive", contextWindowSize: 500000 } }
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Config-time coordination, no runtime state | Arena is a factory, not a runtime. L2 packages own their runtime behavior — arena just allocates budgets coherently |
| Presets over per-value defaults | Users think in profiles ("I want conservative"), not in individual threshold fractions |
| Derive all budgets from `contextWindowSize` + preset | Single source of truth. Change window size → all thresholds scale automatically |
| `editingTrigger < compactorTrigger` invariant | Cheap operations (tool-result trimming) should fire before expensive ones (LLM summarization) |
| Async factory | `FsMemory` initialization requires I/O. Sync callers pay zero cost (async on a non-Promise is a no-op) |
| Deferred hydrator factory | `createContextHydrator()` needs an `Agent` ref, but agents don't exist until after `createKoi()`. Arena pre-configures; user calls `createHydrator(agent)` post-assembly |
| Default in-memory archiver | Zero-config happy path. Production users provide their own persistent store |
| Shared token estimator instance | Ensures all 3 middleware count tokens identically. No drift between compactor and editing estimates |
| `ContextArenaMiddlewareFactory` defined locally | Avoids L3→L3 dependency on `@koi/starter`. The type is trivial — one function signature |
| Accept L2 priorities as-is | Arena doesn't re-assign priorities. L2 packages own their middleware ordering |
| `threadStore` is a top-level config field | It gates the feature (like `memoryFs`). Conversation overrides go in a separate `conversation` section |
| Conversation opt-in via `threadStore` | Only wired when `threadStore` is provided and `conversation.disabled !== true`. No threadStore → no conversation middleware, no overhead |
| Conversation history budget is preset-driven | Token budget scales with context window size (2%/3%/5%) like hot-memory. `maxMessages` stays flat at 200 — it's a safety cap, not a budget |
| TokenEstimator bridge falls back to chars/4 | Conversation middleware requires sync `(text) => number`. If arena's estimator is async, the fallback matches conversation's own default |

---

## Testing

```
presets.test.ts — 12 tests
  Property-based invariants across 5 window sizes × 3 presets:
  ● softTrigger < hardTrigger for all presets
  ● editingTrigger < compactorTrigger (token count)
  ● conservative.trigger ≤ balanced.trigger ≤ aggressive.trigger
  ● All values positive (including conversationMaxHistoryTokens)
  ● maxSummaryTokens scales with window size
  ● Conversation history budget scales with window size
  ● conservative ≤ balanced ≤ aggressive conversation history fractions
  ● Balanced at 200K produces 6,000 conversation tokens

config-resolution.test.ts — 15 tests
  ● Default preset is "balanced"
  ● Default context window is 200K
  ● Default heuristic estimator when none provided
  ● Default in-memory archiver when none provided
  ● User overrides take precedence over preset
  ● Throws on non-positive contextWindowSize
  ● Throws on NaN contextWindowSize
  ● Throws on Infinity contextWindowSize
  ● Feature flags (hydrator, memoryFs) derived correctly
  ● conversationEnabled false by default (no threadStore)
  ● conversationEnabled true when threadStore provided
  ● conversationEnabled false when disabled even with threadStore
  ● Conversation token budget uses preset when no override
  ● Conversation user overrides take precedence
  ● conversationMaxMessages defaults to 200

arena-factory.test.ts — 22 tests
  ● Bundle always has 3 middleware (without threadStore)
  ● Bundle always has 1 provider (squash)
  ● Middleware in correct priority order (220 < 225 < 250)
  ● Memory provider included when memoryFs config provided
  ● Hydrator deferred factory present when hydrator config provided
  ● createHydrator returns ContextHydratorMiddleware
  ● Shared token estimator across all middleware
  ● Resolved config accessible on bundle
  ● memoryFs adds memory provider to bundle (2 providers)
  ● No memoryFs means only squash provider (1 provider)
  ● config.memory alongside memoryFs still produces 2 providers
  ● memoryFs does not affect middleware count
  ● Wrapper retriever flows through to createFsMemory
  ● Wrapper retriever overrides config.retriever
  ● config.retriever used when wrapper retriever absent
  ● Wrapper indexer flows through independently
  ● Conversation not added when no threadStore
  ● Conversation added when threadStore provided (4 middleware)
  ● Priority order includes conversation at 100 (100, 220, 225, 250)
  ● Conversation not added when disabled even with threadStore
  ● Conversation + memoryFs produces 6 middleware
  ● Resolved config values flow through to conversation

registry-adapter.test.ts — 3 tests
  ● Entries map contains "context-arena" key
  ● Factory returns valid compactor middleware
  ● getBundle() returns full bundle after factory invocation

__tests__/composition.test.ts — 4 tests (integration)
  ● Middleware priority ordering correct (without conversation)
  ● Middleware priority ordering with conversation (100 < 220 < 225 < 250)
  ● All middleware share same tokenEstimator instance
  ● Full bundle round-trip: config → create → spread into mock runtime
```

```bash
bun --cwd packages/context-arena test
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    KoiMiddleware, ModelHandler, TokenEstimator, SessionId,  │
    SnapshotChainStore, PruningPolicy, ComponentProvider,    │
    Agent, MemoryComponent, InboundMessage                   │
                                                             │
L2  @koi/middleware-compactor ─────────┐                     │
    @koi/middleware-context-editing ────┤                     │
    @koi/middleware-conversation ───────┤                     │
    @koi/tool-squash ──────────────────┤                     │
    @koi/context ──────────────────────┤                     │
    @koi/memory-fs ────────────────────┤                     │
    @koi/token-estimator ──────────────┤                     │
    @koi/snapshot-chain-store (L0u) ───┤                     │
                                       ▼                     │
L3  @koi/context-arena ◄──────────────────────────────────────┘
    imports from L0 + L2 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L3 packages (@koi/starter)
    ✓ All interface properties readonly
    ✓ Immutable patterns (no Array.push, no mutation)
    ✓ import type for type-only imports
    ✓ .js extensions on all local imports
    ✓ No enum, any, namespace, as Type, ! in production code
    ✓ Type guards instead of type assertions
```
