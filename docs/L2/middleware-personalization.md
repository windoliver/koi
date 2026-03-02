# @koi/middleware-personalization — Dual-Channel Preference Learning

`@koi/middleware-personalization` is an L2 middleware package that closes the preference learning loop through two complementary feedback channels:

1. **Pre-action clarification** — injects stored preferences or asks the user to clarify ambiguous instructions before the model acts
2. **Post-action correction** — detects when the user corrects the model and stores the preference for future recall

---

## Why It Exists

Without preference learning, agents repeat the same mistakes:

```
Without personalization:
  User: "Format the output"     → Agent picks JSON (guess)
  User: "No, use YAML"          → Agent switches to YAML
  User: "Format the output"     → Agent picks JSON again (forgot)

With personalization:
  User: "Format the output"     → Agent picks JSON (guess)
  User: "No, use YAML"          → Agent stores: "User prefers YAML"
  User: "Format the output"     → Agent injects [User Preferences: YAML] → picks YAML
```

Based on [PAHF (Liang et al., 2025)](https://arxiv.org/abs/2602.16173): combining pre-action and post-action feedback is strictly better than either alone. Pre-action queries reduce ambiguity errors exponentially. Post-action corrections bound drift errors to O(K) where K = number of preference switches.

---

## Architecture

### Layer Position

```
L0  @koi/core           ─ KoiMiddleware, MemoryComponent, InboundMessage (types only)
L0u @koi/errors          ─ swallowError
L0u @koi/token-estimator ─ estimateTokens
L2  @koi/middleware-personalization ◄── this package (L0 + L0u only)
```

### Internal Module Map

```
index.ts                    ← public re-exports
│
├── config.ts               ← PersonalizationConfig, validation, resolveDefaults
├── personalization.ts      ← createPersonalizationMiddleware() factory
├── ambiguity-classifier.ts ← AmbiguityClassifier interface + default heuristic
├── correction-detector.ts  ← CorrectionDetector interface + default heuristic
├── preference-cache.ts     ← single-entry cache for memory recall results
└── text-extractor.ts       ← extract text from InboundMessage content blocks
```

---

## How It Works

### Pre-Action Channel (every turn)

```
User message arrives
       │
       ▼
  memory.recall(query)  ─── cached after first call
       │
       ├── preferences found (score ≥ 0.7)
       │     └─► inject [User Preferences] message (pinned) → model sees them
       │
       └── no preferences
             │
             ▼
        classifier.classify(instruction)
             │
             ├── ambiguous (question + alternative markers)
             │     └─► inject clarification directive (pinned) → model asks user
             │
             └── clear
                   └─► pass through unchanged
```

Key details:
- Preference messages are `pinned: true` so compactor preserves them during aggressive compaction
- The default classifier uses pure string matching (zero LLM cost)
- Token budget (default 500) caps injected preference size
- Relevance threshold (default 0.7) filters low-quality recall results

### Post-Action Channel (turn > 0 only)

```
User message on turn N (N > 0)
       │
       ├── too short (< 5 words) AND no correction markers?
       │     └─► skip (fast path)
       │
       └── long enough OR has markers ("no,", "actually,", "i prefer")
             │
             ▼
        detector.detect(message)
             │
             ├── corrective + has preference update
             │     └─► memory.store(update, namespace: "preferences")
             │         cache.invalidate()
             │
             └── not corrective
                   └─► pass through
```

Key details:
- Skips turn 0 (nothing to correct yet)
- Short-circuits messages under 5 words without correction markers
- Filters false positives: "no problem", "no worries", "no thanks"
- The default detector uses keyword heuristics (zero LLM cost)

---

## API

### `createPersonalizationMiddleware(config)`

Creates the middleware with both channels enabled by default.

```typescript
import { createPersonalizationMiddleware } from "@koi/middleware-personalization";

const mw = createPersonalizationMiddleware({
  memory: myMemoryComponent,      // required — MemoryComponent from ECS
  relevanceThreshold: 0.7,        // default: 0.7
  maxPreferenceTokens: 500,       // default: 500
  preferenceNamespace: "preferences", // default: "preferences"
});
```

Returns `KoiMiddleware` with:
- `name: "personalization"`
- `priority: 420`
- `describeCapabilities()` — reports active channels
- `wrapModelCall()` — pre-action injection + post-action detection

### `PersonalizationConfig`

```typescript
interface PersonalizationConfig {
  readonly memory: MemoryComponent;                // required
  readonly preAction?: PreActionConfig;            // default: enabled
  readonly postAction?: PostActionConfig;          // default: enabled
  readonly relevanceThreshold?: number;            // default: 0.7
  readonly maxPreferenceTokens?: number;           // default: 500
  readonly preferenceNamespace?: string;           // default: "preferences"
  readonly onError?: (error: unknown) => void;     // default: swallowError
}

interface PreActionConfig {
  readonly enabled?: boolean;                      // default: true
  readonly classifier?: AmbiguityClassifier;       // default: keyword heuristic
  readonly maxQuestionTokens?: number;             // default: 100
}

interface PostActionConfig {
  readonly enabled?: boolean;                      // default: true
  readonly detector?: CorrectionDetector;          // default: keyword heuristic
}
```

### Pluggable Classifiers

Both `AmbiguityClassifier` and `CorrectionDetector` are strategy interfaces — swap in model-based implementations when you need higher accuracy:

```typescript
interface AmbiguityClassifier {
  readonly classify: (
    instruction: string,
    relevantPreferences: readonly MemoryResult[],
  ) => AmbiguityAssessment | Promise<AmbiguityAssessment>;
}

interface CorrectionDetector {
  readonly detect: (
    message: string,
    recentContext: readonly InboundMessage[],
  ) => CorrectionAssessment | Promise<CorrectionAssessment>;
}
```

---

## Context Arena Integration

When using `@koi/context-arena`, personalization is an opt-in module that shares memory and budget allocation:

```typescript
import { createContextArena } from "@koi/context-arena";

const bundle = await createContextArena({
  summarizer: myModelHandler,
  sessionId: mySessionId,
  getMessages: () => messages,
  memory: myMemoryComponent,
  personalization: { enabled: true },  // opt-in
});

// bundle.middleware: [squash(220), compactor(225), context-editing(250), personalization(420)]
```

Configuration overrides:

```typescript
personalization: {
  enabled: true,
  relevanceThreshold: 0.5,      // lower threshold = more preferences injected
  maxPreferenceTokens: 200,     // tighter budget
}
```

Personalization requires `memory` — if no memory component is provided, the middleware is silently omitted even when `enabled: true`.

---

## Performance Properties

| Operation | Cost | When |
|-----------|------|------|
| `memory.recall()` | 1 call, then cached | First turn only (per middleware instance) |
| `filterByRelevance()` | O(n) array filter | Every turn with pre-action enabled |
| `capByTokenBudget()` | O(n) with token estimation | Every turn with preferences found |
| `classifier.classify()` | O(markers) string matching | Only when no preferences + pre-action |
| `looksLikeCorrection()` | O(1) string prefix check | Every turn > 0 with post-action |
| `detector.detect()` | O(markers) string matching | Only when message passes short-circuit |
| `memory.store()` | 1 call | Only on detected corrections |

**Zero LLM calls** with default classifiers. The only I/O is `memory.recall()` (cached) and `memory.store()` (rare).

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    KoiMiddleware, MemoryComponent, InboundMessage,      │
    MemoryResult, CapabilityFragment                     │
                                                          │
L0u @koi/errors ────────────────────────────────────┐    │
    swallowError                                    │    │
                                                    │    │
L0u @koi/token-estimator ──────────────────────┐    │    │
    estimateTokens                              │    │    │
                                                ▼    ▼    ▼
L2  @koi/middleware-personalization ◄───────────┘────┘────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external runtime dependencies
```

---

## What This Feature Enables

Agents that **remember and adapt to individual users** without extra LLM calls:

- **Cold start handling** — when the agent has no preferences, it asks before guessing
- **Preference persistence** — corrections are stored and recalled in future sessions
- **Compaction-safe** — pinned messages survive aggressive context compaction
- **Zero-cost defaults** — keyword heuristics mean no extra API calls or latency
- **Pluggable upgrade path** — swap in LLM-based classifiers when accuracy matters more than cost
- **Coordinated budgets** — via context-arena, preferences share the token budget with squash, compactor, and context-editing
