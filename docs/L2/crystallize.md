# @koi/crystallize — Tool Pattern Detection & Forge Bridge

`@koi/crystallize` is an L0u utility that detects repeating tool call patterns in agent sessions and surfaces them as crystallization candidates for potential forging into reusable composite tools. It observes, scores, and suggests — but never auto-forges.

---

## Why It Exists

Agents repeatedly use the same tool sequences: read a file, parse JSON, validate schema. Each repetition costs LLM reasoning tokens to re-derive the same multi-step plan. Crystallization detects these patterns and offers to collapse them into a single composite tool.

```
BEFORE: Agent re-derives same 3-step pattern every time
┌─────────────────────────────────────────────┐
│  Turn 1: read_file → parse_json → validate  │  3 LLM decisions
│  Turn 4: read_file → parse_json → validate  │  3 LLM decisions
│  Turn 7: read_file → parse_json → validate  │  3 LLM decisions
│                                              │
│  Total: 9 LLM decisions for the same thing  │
└─────────────────────────────────────────────┘

AFTER: Pattern detected → composite tool forged
┌─────────────────────────────────────────────┐
│  Crystallize detects: "read-file-then-      │
│    parse-json-then-validate" (3 occurrences)│
│                                              │
│  Forge creates: validate_file_schema tool   │
│  Turn 10+: validate_file_schema             │  1 LLM decision
└─────────────────────────────────────────────┘
```

Without this package, pattern detection would be ad-hoc and tool creation would require manual authoring.

---

## Architecture

### Layer position

```
L0  @koi/core              ─ TurnTrace, KoiMiddleware, Result, KoiError (types only)
L0u @koi/errors             ─ KoiRuntimeError for validation failures
L0u @koi/crystallize        ─ this package (no L1 dependency)
```

`@koi/crystallize` only imports from `@koi/core` (L0) and `@koi/errors` (L0u). It never touches `@koi/engine` (L1). Pattern detection can run in any environment — CLI, test harness, CI.

### Internal module map

```
index.ts                         ← public re-exports
│
├── types.ts                     ← CrystallizeConfig, CrystallizationCandidate, etc.
├── ngram.ts                     ← extractNgrams(), extractNgramsIncremental()
├── detect-patterns.ts           ← detectPatterns(), filterSubsumed()
├── compute-score.ts             ← computeCrystallizeScore(), computeSuccessRate()
├── crystallize-middleware.ts    ← createCrystallizeMiddleware() (incremental)
├── forge-handler.ts             ← createCrystallizeForgeHandler()
├── generate-composite.ts       ← generateCompositeImplementation()
├── pipeline-executor.ts         ← executePipeline(), generatePipelineExecutorCode()
├── auto-forge-middleware.ts     ← createAutoForgeMiddleware()
├── validate-config.ts           ← validateCrystallizeConfig()
│
└── __test-helpers__/
    └── trace-factory.ts         ← shared test utilities
```

---

## How It Works

### Pipeline Overview

```
TurnTrace events from agent session
    │
    ▼
┌────────────────────────────────┐
│  1. Extract tool sequences     │  ngram.ts
│     TurnTrace[] → ToolStep[][] │
└────────────┬───────────────────┘
             │
             ▼
┌────────────────────────────────┐
│  2. Generate n-grams           │  ngram.ts
│     sliding window [min..max]  │
│     key: "tool1|tool2|tool3"   │
└────────────┬───────────────────┘
             │
             ▼
┌────────────────────────────────┐
│  3. Detect patterns            │  detect-patterns.ts
│     filter by minOccurrences   │
│     remove subsumed patterns   │
│     compute scores             │
└────────────┬───────────────────┘
             │
             ▼
┌────────────────────────────────┐
│  4. Surface candidates         │  crystallize-middleware.ts
│     onCandidatesDetected()     │
│     dismiss() for rejected     │
└────────────┬───────────────────┘
             │
             ▼
┌────────────────────────────────┐
│  5. Forge bridge (optional)    │  forge-handler.ts
│     confidence threshold       │
│     → CrystallizedToolDescriptor│
└────────────────────────────────┘
```

### N-gram Extraction

Tool sequences are extracted from `TurnTrace` events, then all n-grams of configurable length are generated via sliding window:

```
Turn trace events:
  [read_file, parse_json, validate, save]

N-grams (size 2-3):
  size 2: read_file|parse_json, parse_json|validate, validate|save
  size 3: read_file|parse_json|validate, parse_json|validate|save
```

Each n-gram has a stable key (pipe-separated tool IDs) for deduplication across turns.

### Subsumption Filtering

When a longer n-gram contains a shorter one with equal or greater frequency, the shorter is removed:

```
Before filtering:
  read_file|parse_json         (5 occurrences)
  read_file|parse_json|validate (5 occurrences)   ← longer, same count

After filtering:
  read_file|parse_json|validate (5 occurrences)   ← keeps the longer pattern
```

This prevents surfacing redundant sub-patterns when a more complete pattern exists.

### Scoring

Candidates are ranked by: `occurrences x stepsReduction x recencyBoost x successRate`

```
┌──────────────────────────────────────────────┐
│  occurrences: 5 times observed               │
│  stepsReduction: max(1, 3 steps - 1) = 2     │
│  recencyBoost: 0.5^(age / halfLife)          │
│  successRate: fraction of steps with         │
│               outcome === "success" (1.0     │
│               when no outcome data)          │
│                                              │
│  At detection:  5 × 2 × 1.0 × 0.9 = 9.0    │
│  After 30 min:  5 × 2 × 0.5 × 0.9 = 4.5    │
│  After 60 min:  5 × 2 × 0.25 × 0.9 = 2.25  │
└──────────────────────────────────────────────┘
```

Recency decay (default half-life: 30 minutes) ensures stale patterns naturally lose priority. Success rate weighting penalizes patterns where tools frequently fail.

### Crystallize Middleware Lifecycle

```
createCrystallizeMiddleware()
    │
    ▼
  onAfterTurn hook (priority 950)
    │
    ├── turnIndex < minTurnsBeforeAnalysis? → skip
    ├── within analysisCooldownTurns?       → skip
    │
    ├── evict stale known/dismissed keys (TTL)
    ├── readTraces() → TurnTrace[]
    ├── detectPatternsIncremental() → candidates[]
    ├── filter already-known candidates
    │
    ├── new candidates found?
    │   └── onCandidatesDetected(newCandidates)
    │
    └── update known keys + last analysis turn
```

The middleware runs at priority 950 (after event-trace at 475) and is observe-only — it never modifies the model request or response.

### Forge Bridge

The forge handler evaluates candidates and produces tool descriptors for high-confidence patterns:

```
candidate.score = 10.0
confidence = recencyBoost component = 1.0
threshold = 0.9
                    │
    ┌───────────────▼──────────────────┐
    │  confidence >= threshold?         │
    │                                   │
    │  YES → CrystallizedToolDescriptor │
    │        name: "read-file-then-..." │
    │        implementation: generated  │
    │        scope: "agent"             │
    │        trustTier: "sandbox"       │
    │        → onForged() callback      │
    │                                   │
    │  NO  → onSuggested() callback     │
    │        (for human-in-the-loop)    │
    └───────────────────────────────────┘
```

Guards prevent runaway forging: `maxForgedPerSession` (default: 3) and deduplication by suggested name.

---

## API Reference

### `createCrystallizeMiddleware(config)`

Factory function that returns a `CrystallizeHandle`.

```typescript
import { createCrystallizeMiddleware } from "@koi/crystallize";

const handle = createCrystallizeMiddleware({
  readTraces: async () => ({ ok: true, value: traces }),
  minTurnsBeforeAnalysis: 5,
  minOccurrences: 3,
  maxCandidates: 5,
  onCandidatesDetected: (candidates) => {
    for (const c of candidates) {
      console.log(`Pattern: ${c.suggestedName} (${c.occurrences}x)`);
    }
  },
});
```

**Config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `readTraces` | `() => Promise<Result<TurnTrace[]>>` | required | Supplies turn traces for analysis |
| `onCandidatesDetected` | `(candidates) => void` | required | Callback when new patterns found |
| `minNgramSize` | `number` | `2` | Minimum tool sequence length |
| `maxNgramSize` | `number` | `5` | Maximum tool sequence length |
| `minOccurrences` | `number` | `3` | Minimum repetitions to surface |
| `maxCandidates` | `number` | `5` | Maximum candidates per analysis |
| `minTurnsBeforeAnalysis` | `number` | `5` | Defer analysis until session matures |
| `analysisCooldownTurns` | `number` | `3` | Minimum turns between analyses |
| `maxPatternAgeMs` | `number` | `3600000` | TTL for known/dismissed keys (1 hour) |
| `clock` | `() => number` | `Date.now` | Clock function (testable) |

**Returns:** `CrystallizeHandle`

| Method | Signature | Description |
|--------|-----------|-------------|
| `middleware` | `KoiMiddleware` | The middleware to register with createKoi |
| `getCandidates` | `() => readonly CrystallizationCandidate[]` | Query current candidates |
| `dismiss` | `(ngramKey: string) => void` | Suppress a candidate (TTL-based expiry) |

### `createCrystallizeForgeHandler(config)`

Factory function that returns a `CrystallizeForgeHandler`.

```typescript
import { createCrystallizeForgeHandler } from "@koi/crystallize";

const handler = createCrystallizeForgeHandler({
  scope: "agent",
  confidenceThreshold: 0.9,
  trustTier: "sandbox",
  maxForgedPerSession: 3,
  onForged: (descriptor) => {
    console.log(`Forged: ${descriptor.name}`);
  },
  onSuggested: (candidate) => {
    console.log(`Suggested: ${candidate.suggestedName}`);
  },
});

const forged = handler.handleCandidates(candidates, Date.now());
```

**Config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `scope` | `ForgeScope` | required | `"agent"` / `"zone"` / `"global"` |
| `confidenceThreshold` | `number` | `0.9` | Minimum confidence to auto-forge (0-1) |
| `trustTier` | `TrustTier` | `"sandbox"` | Trust level for forged tools |
| `maxForgedPerSession` | `number` | `3` | Maximum tools forged per session |
| `onForged` | `(descriptor) => void` | `undefined` | Callback when tool is forged |
| `onSuggested` | `(candidate) => void` | `undefined` | Callback for HITL candidates below threshold |

**Returns:** `CrystallizeForgeHandler`

| Method | Signature | Description |
|--------|-----------|-------------|
| `handleCandidates` | `(candidates, now) => CrystallizedToolDescriptor[]` | Evaluate and optionally forge |
| `getForgedCount` | `() => number` | Number of tools forged this session |

### `detectPatterns(traces, config, dismissed, clock)`

Full recomputation pattern detection. Extracts n-grams, applies subsumption filtering, scores candidates, and returns sorted results.

### `detectPatternsIncremental(newTraces, startTurnIndex, existingNgramMap, config, dismissed, clock)`

Incremental variant that merges new traces into an existing n-gram map. Returns `{ candidates, ngramMap, lastProcessedTurnIndex }` for chaining across analysis cycles.

### `extractNgrams(sequences, minSize, maxSize)`

Generates all n-grams of specified lengths via sliding window from tool sequences. Returns immutable `Map<string, NgramEntry>`.

### `extractNgramsIncremental(newSequences, startTurnIndex, existing, minSize, maxSize)`

Incremental n-gram extraction that merges into an existing map without recomputation.

### `computeCrystallizeScore(candidate, now, config?)`

Computes `occurrences x stepsReduction x recencyBoost`. Configurable half-life (default: 30 minutes).

### `generateCompositeImplementation(candidate)`

Generates TypeScript code for a composite tool that calls each tool in sequence, threading results forward.

### `validateCrystallizeConfig(config)`

Validates config and resolves defaults. Returns `Result<ValidatedCrystallizeConfig, KoiError>`.

---

## Integration with createKoi

```typescript
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import {
  createCrystallizeMiddleware,
  createCrystallizeForgeHandler,
} from "@koi/crystallize";

// Set up trace storage
const traces: TurnTrace[] = [];

// Create crystallize middleware
const crystallize = createCrystallizeMiddleware({
  readTraces: async () => ({ ok: true, value: traces }),
  minTurnsBeforeAnalysis: 5,
  minOccurrences: 3,
  onCandidatesDetected: (candidates) => {
    // Option 1: Log for human review
    console.log("New patterns detected:", candidates);

    // Option 2: Feed to forge bridge
    const forged = forgeHandler.handleCandidates(candidates, Date.now());
    for (const tool of forged) {
      console.log(`Auto-forged: ${tool.name}`);
    }
  },
});

// Optional: forge bridge for auto-creating tools
const forgeHandler = createCrystallizeForgeHandler({
  scope: "agent",
  confidenceThreshold: 0.9,
  maxForgedPerSession: 3,
});

const runtime = await createKoi({
  manifest: {
    name: "my-agent",
    version: "1.0.0",
    model: { name: "claude-haiku-4-5" },
  },
  adapter: createLoopAdapter({ modelCall }),
  middleware: [crystallize.middleware],
});

const events = await collectEvents(
  runtime.run({ kind: "text", text: "Analyze and validate the config files" })
);
```

---

## Design Decisions

1. **Observe-only middleware** — The crystallize middleware never modifies model requests or responses. It hooks `onAfterTurn` to observe, never `wrapModelCall` to intercept.
2. **Decoupled from storage** — `readTraces` is a callback, not a store reference. The caller decides how traces are stored (in-memory array, SQLite, snapshot chain).
3. **Incremental computation** — N-gram maps and detection results can be chained across analysis cycles to avoid O(n^2) recomputation in long sessions.
4. **TTL-based eviction** — Known and dismissed pattern keys expire after `maxPatternAgeMs`. Dismissed patterns can resurface if the agent keeps using them.
5. **Forge bridge is separate** — Detection and forging are decoupled. `createCrystallizeMiddleware` surfaces candidates; `createCrystallizeForgeHandler` optionally converts them to tool descriptors. You can use detection without forging.
6. **Confidence = recency** — The current confidence formula reduces to the recency boost component. Fresh patterns near detection time pass the threshold; stale ones don't. This is intentional — parameter flow analysis is deferred to a future iteration.
7. **No L1 dependency** — The detection engine works anywhere. Only the middleware's `onAfterTurn` hook requires the L1 runtime to fire.
