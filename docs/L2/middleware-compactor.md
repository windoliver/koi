# @koi/middleware-compactor — Context Compaction with Fact Preservation

Intercepts every model call/stream and compacts old conversation history into LLM-generated summaries when configurable thresholds are exceeded. Before compaction discards original messages, a fact-extracting archiver extracts structured facts (decisions, artifacts, resolutions, configuration changes) into long-term memory so critical information survives lossy summarization.

---

## Why It Exists

Long-running agent sessions accumulate messages until the context window fills up. Without compaction:

1. **Context rot** — attention quality degrades in the last 20-25% of the context window. The agent starts "forgetting" earlier messages, producing contradictory decisions and hallucinated state.
2. **Hard overflow** — exceeding the model's context limit causes API rejections. The agent crashes mid-task.
3. **Fact loss** — naive summarization discards structured information (file paths, decisions, config changes) that the agent needs to maintain coherence across long sessions.

Without this package:
- Agents hit context limits and crash
- Long sessions suffer progressive quality degradation
- Compacted summaries lose critical structured facts
- No observability into context pressure or compaction history

---

## Architecture

`@koi/middleware-compactor` is an **L2 feature package** — it depends only on `@koi/core` (L0), `@koi/errors` (L0u), and `@koi/resolve` (L0u). Zero external dependencies.

```
┌──────────────────────────────────────────────────────────┐
│  @koi/middleware-compactor  (L2)                          │
│                                                          │
│  types.ts                ← config types, defaults,       │
│                            presets, trigger thresholds    │
│  compact.ts              ← core LlmCompactor: trigger    │
│                            check, split, summarize       │
│  compactor-middleware.ts ← KoiMiddleware factory,        │
│                            CompactorState, soft trigger   │
│  fact-extraction.ts      ← heuristic patterns, extract   │
│  fact-extracting-         ← archiver that stores facts   │
│    archiver.ts             to MemoryComponent before     │
│                            compaction discards messages   │
│  estimator.ts            ← heuristic token estimator     │
│  find-split.ts           ← optimal split via prefix sums │
│  pair-boundaries.ts      ← AI+Tool pair boundary finder  │
│  prompt.ts               ← summary prompt builder        │
│  overflow-recovery.ts    ← catch overflow, force-compact │
│  memory-compaction-       ← in-memory CompactionStore    │
│    store.ts                                              │
│  descriptor.ts           ← BrickDescriptor for manifest  │
│  index.ts                ← public API surface            │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Dependencies                                            │
│                                                          │
│  @koi/core    (L0)   KoiMiddleware, ModelRequest,        │
│                       InboundMessage, CompactionResult,   │
│                       TokenEstimator, MemoryComponent     │
│  @koi/errors  (L0u)  isContextOverflowError              │
│  @koi/resolve (L0u)  BrickDescriptor                     │
└──────────────────────────────────────────────────────────┘
```

Priority **225** — runs after pay middleware (200), before context-editing (250).

---

## How It Works

### Compaction Lifecycle

```
  Model Call / Stream
       │
       ▼
┌──────────────────────────────────────────────┐
│  wrapModelCall / wrapModelStream             │
│                                              │
│  1. Check cached session restore             │
│  2. Estimate tokens (heuristic: 4 chars/tok) │
│  3. Check trigger conditions                 │
│  4. If triggered → compact                   │
│  5. Cache token fraction for soft trigger     │
│  6. Pass compacted request to next()         │
└──────────────────┬───────────────────────────┘
                   │
       ┌───────────┴──────────────┐
    not triggered              triggered
       │                          │
    pass through          ┌───────▼────────────────────┐
                          │  performCompaction()        │
                          │                            │
                          │  1. Find valid split points │
                          │     (respect AI+Tool pairs) │
                          │  2. Find optimal split      │
                          │     (prefix-sum + target)   │
                          │  3. Extract facts → memory  │
                          │     (archiver, if wired)    │
                          │  4. Summarize head messages  │
                          │     (LLM call)              │
                          │  5. Tag summary with epoch  │
                          │  6. Return [summary, ...tail]│
                          └────────────────────────────┘
```

### Trigger Conditions

Any satisfied condition fires compaction. All are optional — at least one must be set.

| Trigger | Default | Description |
|---------|---------|-------------|
| `tokenFraction` | **0.60** | Fraction of `contextWindowSize`. Fires when `tokens ≥ windowSize × 0.60`. |
| `softTriggerFraction` | **0.50** | Warning only — no compaction. Surfaces pressure in `describeCapabilities`. |
| `tokenCount` | — | Absolute token count threshold. |
| `messageCount` | — | Message count threshold. |

```
Context Window
0%─────────────────50%──────────60%──────────────────100%
                     ▲            ▲
                soft trigger   hard trigger
                (warning)      (compact!)

◄─── Sweet Spot ───►
     (40-60%)
Agent lives here with
peak attention quality
```

### Soft Trigger (Context Pressure Warning)

When the token fraction exceeds `softTriggerFraction` but stays below the hard trigger, `describeCapabilities()` returns a pressure warning:

```
Context pressure: 52% — consider summarizing completed work phases
```

This surfaces in the agent's system prompt, nudging it to proactively wrap up work phases before the hard trigger fires. No compaction occurs — it's advisory only.

### Epoch Tracking

Each successful compaction increments an epoch counter. The epoch is stamped on the summary message metadata:

```typescript
metadata: { compacted: true, compactionEpoch: 0 }  // first compaction
metadata: { compacted: true, compactionEpoch: 1 }  // second compaction
```

This enables downstream middleware and tooling to reason about compaction history — which generation of summary the agent is working from, and when information might have been compressed.

### CompactorState

The middleware uses a single immutable state record, updated via spread on each mutation:

```typescript
interface CompactorState {
  readonly epoch: number;              // increments on each compaction
  readonly lastTokenFraction: number;  // cached for soft trigger reads
  readonly cachedRestore: CompactionResult | undefined;  // session restore
}
```

---

## Fact Extraction Pipeline

### Problem

LLM summarization is lossy. When the compactor summarizes 30 messages into a paragraph, structured facts are lost:

```
BEFORE compaction:                  LLM Summary:
"We decided to use Bun"            "The team discussed runtime
"Created /src/server.ts"     →      options and set up a server
"Fixed CORS by updating cfg"        with some configuration."
"Set port to 3000"
                                    ✗ Which runtime? Lost.
                                    ✗ Which file? Lost.
                                    ✗ What was fixed? Lost.
                                    ✗ What port? Lost.
```

### Solution: Extract Before Summarize

The `createFactExtractingArchiver` runs heuristic pattern matching on messages **before** the LLM summary replaces them, storing structured facts to a `MemoryComponent`:

```
Messages to compact:
  [m1] [m2] [m3] [m4] [m5]
    │    │    │    │    │
    ▼    ▼    ▼    ▼    ▼
┌────────────────────────────┐
│  Heuristic Fact Extraction │
│  (microseconds, zero cost) │
└──────────┬─────────────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
 memory-fs    LLM Summary
 (facts       (lossy, but
  survive)     that's ok now)
```

### Five Default Heuristic Patterns

| # | Pattern | Matches | Category | Example |
|---|---------|---------|----------|---------|
| 1 | **Artifact Tool** | Tool results from `write_file`, `create_file`, `edit_file` | `artifact` | `[write_file] Created /src/server.ts` |
| 2 | **Decision** | Messages with decision language (`decided`, `chose`, `going with`, etc.) | `decision` | `We decided to use Bun as the runtime` |
| 3 | **Resolution** | Error resolution messages (`fixed`, `resolved`, `root cause was`, etc.) | `resolution` | `Fixed by updating the tsconfig` |
| 4 | **Configuration** | Setting changes (`set X to Y`, `configured X to Y`) | `configuration` | `Configured port to 3000` |
| 5 | **File Path** | Tool results containing file paths | `artifact` | `File paths: /src/a.ts, /src/b.ts` |

Each message is tested against all patterns. First match wins per message.

### Reinforcement

When the same fact is extracted across multiple compactions (e.g., "We decided to use Bun" appears in epoch 0 and epoch 1), the archiver passes `reinforce: true` to `memory.store()`. This increments the existing fact's `accessCount` instead of creating a duplicate — boosting its salience in the memory tier system.

```
Compaction epoch 0:  "decided Bun" → store (new, accessCount: 0)
Compaction epoch 1:  "decided Bun" → store (reinforce, accessCount: 1)
Compaction epoch 2:  "decided Bun" → store (reinforce, accessCount: 2)
                                                        ▲
                                     Higher accessCount = stays in HOT tier longer
```

---

## Overflow Recovery

When enabled, catches `ContextOverflowError` from the downstream model call, force-compacts the request, and retries:

```
  wrapModelCall(request)
       │
       ▼
  compact(request)
       │
       ▼
  next(compactedRequest) ──── ContextOverflowError
       │                              │
       │                     forceCompact(request)
       │                              │
       │                     next(recompactedRequest)
       │                              │
    success                        success
```

Configurable via `overflowRecovery: { maxRetries: N }`. Default: 1 retry.

---

## Streaming Behavior

Both `wrapModelCall` and `wrapModelStream` apply identical compaction logic before delegating to `next()`. For streaming, overflow recovery catches errors before any chunks are yielded (API-level rejection), so no partial data needs to be undone.

---

## Presets

Named presets for common configurations:

| Preset | tokenFraction | softTriggerFraction | Use case |
|--------|--------------|--------------------|----|
| *(default)* | 0.60 | 0.50 | Recommended — Goldilocks zone |
| `aggressive` | 0.75 | — | Pre-v2 behavior, max context usage |

```typescript
import { COMPACTOR_PRESETS } from "@koi/middleware-compactor";

// Use aggressive preset (old behavior)
createCompactorMiddleware({
  summarizer: modelCall,
  ...COMPACTOR_PRESETS.aggressive,
});
```

---

## API Reference

### `createCompactorMiddleware(config: CompactorConfig): KoiMiddleware`

Main factory. Returns a middleware at priority 225 with `wrapModelCall`, `wrapModelStream`, and state-aware `describeCapabilities`.

### `createLlmCompactor(config: CompactorConfig): LlmCompactor`

Core compaction logic without the middleware wrapper. Useful for testing or custom integration.

```typescript
interface LlmCompactor extends ContextCompactor {
  readonly compact: (
    messages: readonly InboundMessage[],
    maxTokens: number,
    model?: string,
    epoch?: number,
  ) => Promise<CompactionResult>;
  readonly forceCompact: (
    messages: readonly InboundMessage[],
    maxTokens: number,
    model?: string,
    epoch?: number,
  ) => Promise<CompactionResult>;
}
```

### `createFactExtractingArchiver(memory: MemoryComponent, config?: Partial<FactExtractionConfig>): CompactionArchiver`

Creates an archiver that extracts structured facts from messages and stores them to a `MemoryComponent` before compaction discards the originals.

### `createMemoryCompactionStore(): CompactionStore`

In-memory `CompactionStore` for session restore. Holds one `CompactionResult` per session ID.

### Key Types

```typescript
interface CompactorConfig {
  readonly summarizer: ModelHandler;
  readonly summarizerModel?: string;
  readonly contextWindowSize?: number;        // Default: 200_000
  readonly trigger?: CompactionTrigger;       // Default: { tokenFraction: 0.60, softTriggerFraction: 0.50 }
  readonly preserveRecent?: number;           // Default: 4
  readonly maxSummaryTokens?: number;         // Default: 1000
  readonly tokenEstimator?: TokenEstimator;   // Default: heuristic (4 chars/token)
  readonly promptBuilder?: PromptBuilder;
  readonly archiver?: CompactionArchiver;     // Fact extraction hook
  readonly store?: CompactionStore;           // Session restore
  readonly overflowRecovery?: OverflowRecoveryConfig;
}

interface CompactionTrigger {
  readonly tokenFraction?: number;            // Default: 0.60
  readonly softTriggerFraction?: number;      // Default: 0.50
  readonly tokenCount?: number;
  readonly messageCount?: number;
}

interface FactExtractionConfig {
  readonly strategy: "heuristic";
  readonly patterns?: readonly HeuristicPattern[];
  readonly minFactLength?: number;            // Default: 10
  readonly reinforce?: boolean;               // Default: true
}

interface HeuristicPattern {
  readonly match: RegExp | ((msg: InboundMessage) => boolean);
  readonly category: string;
  readonly extractFact?: (msg: InboundMessage) => string | undefined;
}
```

---

## Examples

### Basic: Compactor middleware with defaults

```typescript
import { createCompactorMiddleware } from "@koi/middleware-compactor";

const middleware = createCompactorMiddleware({
  summarizer: modelCall,
  summarizerModel: "claude-haiku-4-5-20251001",
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [middleware],
});
```

### With fact extraction to memory-fs

```typescript
import { createCompactorMiddleware, createFactExtractingArchiver } from "@koi/middleware-compactor";
import { createFsMemory } from "@koi/memory-fs";

const fsMemory = await createFsMemory({ baseDir: "./memory" });
const archiver = createFactExtractingArchiver(fsMemory.component);

const middleware = createCompactorMiddleware({
  summarizer: modelCall,
  summarizerModel: "claude-haiku-4-5-20251001",
  archiver,
});
```

### With custom heuristic patterns

```typescript
import {
  createFactExtractingArchiver,
  DEFAULT_HEURISTIC_PATTERNS,
} from "@koi/middleware-compactor";
import type { HeuristicPattern } from "@koi/middleware-compactor";

const customPattern: HeuristicPattern = {
  match: /\b(deployed|shipped|released)\b/i,
  category: "milestone",
};

const archiver = createFactExtractingArchiver(memory.component, {
  patterns: [...DEFAULT_HEURISTIC_PATTERNS, customPattern],
});
```

### With overflow recovery + session restore

```typescript
import {
  createCompactorMiddleware,
  createMemoryCompactionStore,
} from "@koi/middleware-compactor";

const middleware = createCompactorMiddleware({
  summarizer: modelCall,
  store: createMemoryCompactionStore(),
  overflowRecovery: { maxRetries: 2 },
});
```

### Aggressive preset (pre-v2 behavior)

```typescript
import { createCompactorMiddleware, COMPACTOR_PRESETS } from "@koi/middleware-compactor";

const middleware = createCompactorMiddleware({
  summarizer: modelCall,
  ...COMPACTOR_PRESETS.aggressive,  // tokenFraction: 0.75, no soft trigger
});
```

---

## Middleware Position (Onion)

```
         Incoming Model Call
                │
                ▼
  ┌─────────────────────────┐
  │  middleware-pay          │  priority: 200
  ├─────────────────────────┤
  │  middleware-compactor    │  priority: 225  ◄─ THIS
  │  (THIS)                 │
  ├─────────────────────────┤
  │  middleware-context-edit │  priority: 250
  ├─────────────────────────┤
  │  middleware-guardrails   │  priority: 375
  ├─────────────────────────┤
  │  engine adapter          │
  │  → LLM API call         │
  └─────────────────────────┘
```

---

## Layer Compliance

- [x] `@koi/core` (L0) — types only, zero logic
- [x] `@koi/errors` (L0u) — `isContextOverflowError` utility
- [x] `@koi/resolve` (L0u) — `BrickDescriptor` for manifest resolution
- [x] No imports from `@koi/engine` (L1) or peer L2 packages
- [x] All interface properties are `readonly`
- [x] `MemoryComponent` injected via DI — no L2-to-L2 coupling with `@koi/memory-fs`
- [x] `let` bindings justified with comments
- [x] Immutable state updates via spread (`state = { ...state, epoch: state.epoch + 1 }`)
