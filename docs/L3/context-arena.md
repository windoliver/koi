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
  │ middleware: [squash(220), compactor(225), editing(250)]│
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
  220     squash                  @koi/tool-squash                Agent calls squash() tool
  225     compactor               @koi/middleware-compactor       tokenFraction threshold (LLM call)
  250     context-editing         @koi/middleware-context-editing triggerTokenCount threshold
  300     context-hydrator        @koi/context                   Session start (pre-loads context)
```

Cascade behavior: squash (220) fires first → reduces context → compactor (225) may skip if below threshold → context-editing (250) clears remaining stale tool results. Self-limiting by design.

Key invariant: **editing trigger < compactor trigger** — editing clears stale tool results (cheap, no LLM call) before compaction fires (expensive LLM summarization).

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
| `memory` | `MemoryComponent` | `undefined` | Squash fact extraction target |
| `archiver` | `SnapshotChainStore` | In-memory store | Snapshot archive |
| `pruningPolicy` | `PruningPolicy` | `undefined` | Archive pruning |
| `compactor` | `CompactorOverrides` | — | Override compactor settings |
| `contextEditing` | `ContextEditingOverrides` | — | Override editing settings |
| `squash` | `SquashOverrides` | — | Override squash settings |
| `hydrator` | `{ config: ContextManifestConfig }` | — | Enable context hydrator |
| `memoryFs` | `{ config: FsMemoryConfig }` | — | Enable filesystem memory |

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
  readonly middleware: readonly KoiMiddleware[];  // [squash, compactor, editing]
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

---

## Testing

```
presets.test.ts — 9 tests
  Property-based invariants across 5 window sizes × 3 presets:
  ● softTrigger < hardTrigger for all presets
  ● editingTrigger < compactorTrigger (token count)
  ● conservative.trigger ≤ balanced.trigger ≤ aggressive.trigger
  ● All values positive
  ● maxSummaryTokens scales with window size

config-resolution.test.ts — 9 tests
  ● Default preset is "balanced"
  ● Default context window is 200K
  ● Default heuristic estimator when none provided
  ● Default in-memory archiver when none provided
  ● User overrides take precedence over preset
  ● Throws on non-positive contextWindowSize
  ● Throws on NaN contextWindowSize
  ● Throws on Infinity contextWindowSize
  ● Feature flags (hydrator, memoryFs) derived correctly

arena-factory.test.ts — 8 tests
  ● Bundle always has 3 middleware
  ● Bundle always has 1 provider (squash)
  ● Middleware in correct priority order (220 < 225 < 250)
  ● Memory provider included when memoryFs config provided
  ● Hydrator deferred factory present when hydrator config provided
  ● createHydrator returns ContextHydratorMiddleware
  ● Shared token estimator across all middleware
  ● Resolved config accessible on bundle

registry-adapter.test.ts — 3 tests
  ● Entries map contains "context-arena" key
  ● Factory returns valid compactor middleware
  ● getBundle() returns full bundle after factory invocation

__tests__/composition.test.ts — 3 tests (integration)
  ● Middleware priority ordering correct
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
