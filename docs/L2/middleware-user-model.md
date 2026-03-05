# @koi/middleware-user-model — Unified User Model Middleware

`@koi/middleware-user-model` is an L2 middleware package that unifies preference learning, drift detection, and sensor enrichment into a single `[User Context]` block. It replaces the separate `@koi/middleware-personalization` (pre/post-action channels) and `@koi/middleware-preference` (drift detection + salience gate) with one coordinated pipeline.

---

## Why It Exists

User modeling was fragmented across three independent middleware that shared the same `MemoryComponent` backend and operated on overlapping data:

```
Before (3 middleware, 3 context blocks, 3 memory recall calls):

  priority 410: mw-preference        → drift detection + salience gate
  priority 420: mw-personalization   → pre-action + post-action channels
  (proposed):   sensor enrichment    → IDE/environment signals

  Problems:
  ✗ Duplicate memory.recall() calls (N+1 query problem)
  ✗ Disconnected context blocks compete for token budget
  ✗ No coordination between drift detection and correction detection
  ✗ Sensor signals have no standard ingestion path

After (1 middleware, 1 context block, 1 memory recall call):

  priority 415: mw-user-model        → all channels unified

  ✓ Single memory.recall() with turn-level cache
  ✓ One [User Context] block with coordinated sub-budgets
  ✓ Drift and correction signals flow through shared SignalSink
  ✓ SignalSource interface for pluggable sensor enrichment
```

Based on [PAHF (Liang et al., 2025)](https://arxiv.org/abs/2602.16173): combining pre-action, post-action, and sensor feedback is strictly better than any subset. Dropping any one channel provably increases error.

---

## What This Feature Enables

### For agent builders

- **Single middleware replaces two** — one `createUserModelMiddleware()` call instead of wiring `mw-personalization` + `mw-preference` separately
- **Coordinated token budgets** — preferences (400), sensor state (100), and meta/clarification (100) share one `[User Context]` block instead of competing as separate injections
- **N+1 query elimination** — single `memory.recall()` per turn with turn-scoped cache, instead of each middleware recalling independently
- **SignalSource interface** — plug in IDE state, environment sensors, or any external context via a simple `{ name, read() }` contract with automatic timeout and failure isolation
- **Unified signal pipeline** — corrections, drift, and sensor data all flow through `SignalSink.ingest()`, enabling future coordination (e.g., sensor data confirming drift)
- **Clean replacement** — old `mw-personalization` and `mw-preference` packages have been removed; `mw-user-model` is the sole implementation

### For users

- **Faster responses** — one memory query instead of two, parallel sensor reads with timeout
- **Better context** — the model sees one coherent `[User Context]` block instead of fragmented preference/drift injections
- **Agents that adapt across all channels** — preference learning, drift correction, and environment awareness work together instead of independently

### Failure mode coverage

| Scenario | Without unified middleware | With unified middleware |
|---|---|---|
| User changes preference | Two middleware may conflict | Single pipeline: drift → supersede → store |
| Sensor source times out | No sensor support | Skipped after 200ms, preferences still work |
| All sensors fail | N/A | Empty sensor state, preference pipeline unaffected |
| LLM classifier is down | Each middleware handles separately | Drift: fail-closed, salience: fail-open (consistent) |
| Memory recall fails | Two independent failures | Single failure point, graceful degradation |

---

## Architecture

### Layer Position

```
L0  @koi/core               ─ KoiMiddleware, MemoryComponent, UserSignal,
                                SignalSource, UserSnapshot, UserModelComponent
L0u @koi/errors              ─ swallowError
L0u @koi/token-estimator     ─ estimateTokens
L2  @koi/middleware-user-model ◄── this package (L0 + L0u only)
```

### Internal Module Map

```
index.ts                      ← public re-exports
│
├── types.ts                  ← UserModelConfig, ResolvedUserModelConfig
├── config.ts                 ← validateUserModelConfig() + resolveUserModelDefaults()
├── user-model-middleware.ts  ← createUserModelMiddleware() factory
│
├── snapshot-cache.ts         ← turn-scoped lazy cache with eager invalidation
├── signal-reader.ts          ← parallel SignalSource reader with per-source timeout
├── context-injector.ts       ← formats [User Context] block with sub-budgets
│
├── ambiguity-classifier.ts   ← heuristic pre-action ambiguity detection
├── correction-detector.ts    ← heuristic post-action correction detection
├── text-extractor.ts         ← extract text from InboundMessage content blocks
│
├── keyword-drift.ts          ← 8 regex patterns, zero LLM cost
├── llm-drift.ts              ← LLM-based drift with old/new extraction
├── cascaded-drift.ts         ← keyword pre-filter → LLM confirmation
└── llm-salience.ts           ← LLM-as-judge noise filter
```

### Lifecycle Hook Mapping

| Hook | What runs |
|---|---|
| `onSessionStart` | Register session as active |
| `onBeforeTurn` | Read signal sources → detect corrections → detect drift → ingest signals → invalidate cache |
| `wrapModelCall` | Build snapshot (lazy cached) → format `[User Context]` → inject as pinned message |
| `onSessionEnd` | Remove session from active set |
| `describeCapabilities` | Report active channels |

---

## How It Works

### Signal Processing Pipeline (onBeforeTurn)

```
onBeforeTurn
│
├─ Read all SignalSources in parallel (Promise.allSettled, 200ms timeout)
│  └─ Source throws/times out? → skipped, others still read
│
├─ Extract text from last user message
│  └─ No text? → return (skip turn)
│
├─ Run correction detector (fail-open: swallow errors):
│  ├─ Short message (< 5 words) without markers? → skip
│  ├─ Correction detected? → ingest post_action signal (source: "explicit")
│  └─ Not corrective? → continue
│
├─ Run drift detector (fail-closed: assume drift on error):
│  ├─ Keyword-only: 8 regex patterns, zero LLM cost
│  ├─ Cascaded: keyword pre-filter → LLM confirmation
│  └─ Drift detected? → ingest post_action signal (source: "drift", supersedes old)
│
└─ Invalidate snapshot cache (forces rebuild on next wrapModelCall)
```

### Context Injection (wrapModelCall)

```
wrapModelCall(turnCtx, request, next)
│
├─ Build UserSnapshot (lazy cached per turn):
│  ├─ memory.recall() — single call, turn-level cache
│  ├─ Filter by relevance threshold (default 0.7)
│  ├─ Aggregate sensor state from ingested signals
│  └─ Run ambiguity classifier if no relevant preferences
│
├─ Format [User Context] block with sub-budgets:
│  ├─ Preferences section: up to 400 tokens
│  ├─ Sensor state section: up to 100 tokens
│  └─ Meta section (clarification): up to 100 tokens
│
├─ Inject as pinned message at position 0
│
└─ next(enrichedRequest)
```

### Rendered Output

The model sees a single coherent block:

```
[User Context]
Preferences:
- User prefers YAML output format
- User uses 2-space indentation
Sensor State:
- ide: {"theme":"dark","language":"typescript"}
[/User Context]
```

Or when ambiguity is detected and no preferences exist:

```
[User Context]
Clarification: The instruction is ambiguous. Ask the user to clarify before proceeding.
[/User Context]
```

### Error Handling: Asymmetric Safety

| Component | On error | Rationale |
|---|---|---|
| Signal source read | **Skip source** | Other sources + preferences still work |
| Correction detection | **Fail-open** (swallow) | Missing a correction is recoverable |
| Drift detection | **Fail-closed** (assume drift) | Better to store a possibly-changed preference than to miss a real change |
| Salience gate | **Fail-open** (treat as salient) | Better to store something potentially unimportant than to lose a real preference |
| Memory recall | **Empty preferences** | Model works without preferences |

---

## API

### `createUserModelMiddleware(config)`

Creates the unified middleware with all channels coordinated.

```typescript
import { createUserModelMiddleware } from "@koi/middleware-user-model";

const mw = createUserModelMiddleware({
  memory: myMemoryComponent,         // required — MemoryComponent from ECS
  preAction: { enabled: true },      // ambiguity detection (default: enabled)
  postAction: { enabled: true },     // correction detection (default: enabled)
  drift: {                           // drift detection (default: disabled)
    enabled: true,
    classify: (prompt) => haiku(prompt),
  },
  signalSources: [ideSignalSource],  // optional sensor enrichment
});
```

Returns `KoiMiddleware` with:
- `name: "user-model"`
- `priority: 415`
- `describeCapabilities()` — reports active channels
- `onBeforeTurn()` — signal processing pipeline
- `wrapModelCall()` — context injection

### `UserModelConfig`

```typescript
interface UserModelConfig {
  readonly memory: MemoryComponent;                          // required

  // Channels
  readonly preAction?: { readonly enabled?: boolean } | undefined;         // default: enabled
  readonly postAction?: { readonly enabled?: boolean } | undefined;        // default: enabled
  readonly drift?: {
    readonly enabled?: boolean;
    readonly detector?: PreferenceDriftDetector;
    readonly classify?: LlmClassifier;
  } | undefined;

  // Signal sources
  readonly signalSources?: readonly SignalSource[] | undefined;
  readonly signalTimeoutMs?: number | undefined;             // default: 200

  // Token budgets
  readonly maxPreferenceTokens?: number | undefined;         // default: 400
  readonly maxSensorTokens?: number | undefined;             // default: 100
  readonly maxMetaTokens?: number | undefined;               // default: 100

  // Memory
  readonly relevanceThreshold?: number | undefined;          // default: 0.7
  readonly preferenceNamespace?: string | undefined;         // default: "preferences"
  readonly preferenceCategory?: string | undefined;          // default: "preference"
  readonly recallLimit?: number | undefined;                 // default: 5

  // Salience gate
  readonly salienceGate?: SalienceGate | undefined;

  // Error handling
  readonly onError?: ((error: unknown) => void) | undefined;
}
```

### Individual Component Factories

All detectors from the old packages are re-exported:

```typescript
import {
  createKeywordDriftDetector,    // 8 regex patterns, zero LLM cost
  createLlmDriftDetector,        // LLM-based with old/new extraction
  createCascadedDriftDetector,   // keyword pre-filter → LLM confirmation
  createLlmSalienceGate,         // LLM-as-judge noise filter
} from "@koi/middleware-user-model";
```

---

## Context Arena Integration

`@koi/context-arena` (L3) creates a single `userModelMiddleware` instead of two separate middleware:

```typescript
import { createContextArena } from "@koi/context-arena";

const bundle = await createContextArena({
  summarizer: myModelHandler,
  sessionId: mySessionId,
  getMessages: () => messages,
  memory: myMemoryComponent,
  personalization: { enabled: true },   // enables pre/post-action channels
  preference: { classify: haiku },      // enables drift detection
});

// bundle.middleware includes ONE user-model middleware at priority 415
// instead of TWO separate middleware at priorities 410 and 420
```

---

## Migration from Old Packages

The old `@koi/middleware-personalization` and `@koi/middleware-preference` packages have been removed. Use `@koi/middleware-user-model` directly:

```typescript
import { createUserModelMiddleware } from "@koi/middleware-user-model";

const mw = createUserModelMiddleware({
  memory,
  preAction: { enabled: true },
  postAction: { enabled: true },
  drift: { enabled: true, classify },
});  // priority 415
```

---

## Performance Properties

| Operation | Cost | When |
|---|---|---|
| `memory.recall()` | 1 call, turn-level cache | Once per turn (shared across all channels) |
| Signal source reads | Parallel with 200ms timeout | Once per turn (if sources configured) |
| Keyword drift detection | O(8 patterns × text length) | Every turn with drift enabled |
| LLM drift confirmation | ~25-40 tokens | Only on keyword match (cascaded mode) |
| Salience gate | ~25 tokens | Only on drift detection |
| Correction detection | O(markers) string matching | Every turn > 0 with post-action |
| Ambiguity classification | O(markers) string matching | Only when no preferences + pre-action |
| Context injection | O(preferences + sensors) | Every turn (formats [User Context]) |
| Token estimation | O(text length) | Every turn (for budget enforcement) |

**Key improvement over old architecture**: one `memory.recall()` instead of two, parallel sensor reads instead of sequential middleware, coordinated token budgets instead of competing injections.

**Zero LLM calls** with default classifiers. The only I/O is `memory.recall()` (cached) and `memory.store()` (rare).

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    KoiMiddleware, MemoryComponent, UserSignal,          │
    SignalSource, UserSnapshot, InboundMessage            │
                                                          │
L0u @koi/errors ────────────────────────────────────┐    │
    swallowError                                    │    │
                                                    │    │
L0u @koi/token-estimator ──────────────────────┐    │    │
    estimateTokens                              │    │    │
                                                ▼    ▼    ▼
L2  @koi/middleware-user-model ◄────────────────┘────┘────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external runtime dependencies
```

Verified by `bun run check:layers` — passes with zero violations.

---

## Related

- [Issue #799](https://github.com/windoliver/koi/issues/799) — Unified UserModel Component
- `docs/architecture/Koi.md` — Four-layer architecture
