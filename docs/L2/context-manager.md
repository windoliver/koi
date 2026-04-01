# @koi/context-manager — Auto-Compact + Microcompact Policy

`@koi/context-manager` is an L0u utility package that manages context window pressure through tiered compaction policies: microcompact (truncation at soft threshold) and full compact (LLM summarization at hard threshold), with exponential backoff on failure. As L0u, it is importable by any L1 or L2 package.

---

## Why It Exists

LLM agents accumulate context with every turn. Without compaction, the context window fills and the API rejects the call. With only a single hard threshold, compaction fires at arbitrary moments — the agent loses working context mid-task.

```
Without compaction:
  Turn 1 ─► ... ─► Turn 20 ─► BOOM (context overflow)

With single threshold (v1):
  Turn 1 ─► ... ─► Turn 15 (75%) ─► FULL COMPACT ─► Turn 16
                        │                    │
                        │                    └─ expensive LLM call at arbitrary point
                        └─ agent loses context mid-task

With tiered thresholds (v2, this package):
  Turn 1 ─► ... ─► Turn 10 (50%) ─► MICRO ─► Turn 11 ─► ... ─► Turn 18 (75%) ─► FULL
                        │              │                             │               │
                        │              └─ cheap truncation           │               └─ LLM summary
                        └─ pressure relieved early                   └─ agent chose breakpoint
```

Microcompact at 50% is a cheap pressure-relief valve (truncation, no LLM call). Full compact at 75% is the quality-preserving LLM summarization. The two tiers work together to keep the agent productive without surprise context loss.

---

## Architecture

### Layer Position

```
L0  @koi/core                   ─ ContextCompactor, CompactionResult,
                                   TokenEstimator, ContextPressureTrend,
                                   InboundMessage (types only)
L0u @koi/token-estimator        ─ HEURISTIC_ESTIMATOR, estimateTokens
L0u @koi/errors                 ─ isContextOverflowError

L0u @koi/context-manager        ─ this package (importable by L1 + L2)
    imports: @koi/core, @koi/token-estimator, @koi/errors
```

### Internal Module Map

```
index.ts                    ← public re-exports
│
├── types.ts                ← CompactionManagerConfig (nested), CompactionState
├── policy.ts               ← shouldCompact() → "noop" | "micro" | "full"
├── micro-compact.ts        ← truncation (default) and LLM strategies
├── backoff.ts              ← exponential backoff counter (pure)
├── pressure-trend.ts       ← PressureTrendTracker (circular buffer, ported from v1)
├── find-split.ts           ← optimal split point via prefix sums (ported from v1)
├── pair-boundaries.ts      ← AI+Tool pair boundary detection (ported from v1)
└── overflow-recovery.ts    ← catch overflow → force-compact → retry (ported from v1)
```

---

## Compaction Zones

```
0%        35%           50%            75%         100%
│         │ (micro      │ (soft        │ (hard      │
│  noop   │  target)    │  trigger)    │  trigger)  │ overflow
│         │             │              │            │
│         │             │→ microcompact│→ full      │
│         │             │  (truncate   │  compact   │
│         │             │   to ~35%)   │  (LLM)    │
```

| Zone | Trigger | Action | Cost |
|------|---------|--------|------|
| 0–50% | None | Noop | Zero |
| 50–75% | Soft (`micro.triggerFraction`) | Microcompact: truncate oldest messages to reach ~35% | Zero (no LLM call) |
| 75%+ | Hard (`full.triggerFraction`) | Full compact: LLM summarization of old messages | 1 LLM call |
| Overflow | API rejection | Overflow recovery: force-compact + retry | 1 LLM call |

---

## How It Works

### Policy Decision (Every Turn)

```
estimateTokens(messages)
  │
  ▼
shouldCompact(total, config)
  │
  ├─ total < softTrigger         → "noop"
  ├─ softTrigger ≤ total < hard  → "micro"
  └─ total ≥ hardTrigger         → "full"
```

### Microcompact (Truncation)

When soft threshold is reached, microcompact drops the oldest messages (outside the `preserveRecent` window) until token count is at or below `micro.targetFraction`:

```
Before microcompact (52% occupancy):
  [msg1] [msg2] [msg3] [msg4] [msg5] [msg6] [msg7] [msg8]
   old    old    old    old    old   recent recent recent

After microcompact (target 35%):
  [msg4] [msg5] [msg6] [msg7] [msg8]
                  old   recent recent recent
```

Respects pair boundaries: if `msg4` is a tool result paired with `msg3` (assistant), both are dropped or both are kept.

Pinned messages in the dropped region are extracted and prepended to the tail so they survive truncation. This means a system prompt pinned at index 0 does not block compaction.

If no valid split reaches the target budget, microcompact returns `strategy: "micro-truncate-partial"` instead of `"micro-truncate"`. Callers can distinguish and promote to full compaction.

Optional: set `micro.strategy: "summarize"` to use LLM summarization instead of truncation.

### Full Compact (LLM Summarization)

When hard threshold is reached, full compact finds the optimal split point and summarizes old messages into a structured summary:

```
Before full compact (78% occupancy):
  [msg1] [msg2] [msg3] [msg4] [msg5] [msg6] [msg7] [msg8]
   old    old    old    old    old   recent recent recent

After full compact (~25% occupancy):
  [summary] [msg6] [msg7] [msg8]
```

The summary folds in any previous summary messages (summary-of-summaries), so context degrades gradually over many compaction cycles.

### Exponential Backoff

When a compaction attempt fails (LLM summarizer error), the backoff counter prevents hammering a degraded service:

```
Attempt 1: FAIL → skip 1 turn
Attempt 2: FAIL → skip 2 turns
Attempt 3: FAIL → skip 4 turns
Attempt 4: FAIL → skip 8 turns
  ...
Cap: skip at most 32 turns

Any SUCCESS → reset counter to 0
```

Backoff is shared between micro and full compact (same LLM backend).

### Pressure Trend Tracking

A circular buffer (default 10 samples) tracks token counts per turn and computes:
- `growthPerTurn`: endpoint-to-endpoint average growth rate
- `estimatedTurnsToCompaction`: turns until hard threshold at current growth rate

---

## API

### `shouldCompact(totalTokens, config): CompactionDecision`

Pure policy function. Returns `"noop"`, `"micro"`, or `"full"`.

```typescript
type CompactionDecision = "noop" | "micro" | "full";
```

### `createPressureTrendTracker(windowSize?): PressureTrendTracker`

Factory for the circular-buffer trend tracker.

### `findOptimalSplit(messages, validSplitPoints, contextWindowSize, maxSummaryTokens, estimator): number`

Prefix-sum algorithm to find the best split index.

### `findValidSplitPoints(messages, preserveRecent): readonly number[]`

Returns valid split indices respecting AI+Tool pair boundaries and pinned messages.

### `wrapWithOverflowRecovery(execute, recover, maxRetries): Promise<T>`

Generic retry wrapper for context-overflow errors.

### `CompactionManagerConfig`

```typescript
interface CompactionManagerConfig {
  readonly contextWindowSize?: number;           // default: 200_000
  readonly preserveRecent?: number;              // default: 4
  readonly tokenEstimator?: TokenEstimator;

  readonly micro?: {
    readonly triggerFraction?: number;            // default: 0.50
    readonly targetFraction?: number;             // default: 0.35
    readonly strategy?: "truncate" | "summarize"; // default: "truncate"
  };

  readonly full?: {
    readonly triggerFraction?: number;            // default: 0.75
    readonly maxSummaryTokens?: number;           // default: 1000
  };

  readonly backoff?: {
    readonly initialSkip?: number;               // default: 1
    readonly cap?: number;                       // default: 32
  };
}
```

### `CompactionState`

```typescript
interface CompactionState {
  readonly epoch: number;
  readonly currentTurn: number;
  readonly lastTokenFraction: number;
  readonly consecutiveFailures: number;
  readonly skipUntilTurn: number;
}
```

---

## Design Decisions

### Why tiered thresholds, not sliding window?

Tiered thresholds are deterministic — the behavior is fully determined by `totalTokens / contextWindowSize`. Sliding window approaches with progressive summarization suffer from summary-of-summaries quality degradation and are harder to test deterministically. The tiered approach extends v1's existing soft/hard trigger pattern.

### Why truncation for microcompact?

Microcompact is a pressure-relief valve, not a quality-critical operation. Its job is to free 15–20% of context so the agent can keep working until a natural breakpoint for full compact. Truncation is instant (0ms), free (no LLM call), and sufficient for this purpose. Users who need quality micro-summaries can opt in via `micro.strategy: "summarize"`.

### Why exponential backoff, not circuit breaker?

Both micro and full compact use the same summarizer LLM. A full three-state circuit breaker (Open/HalfOpen/Closed) is warranted for systems with multiple failure modes. Here we have exactly one: the summarizer LLM call. Exponential backoff with two integer counters is simpler, equally deterministic, and trivially testable.

### Why turn-based decay, not wall-clock?

Message age is measured by array position (index 0 = oldest), not wall-clock time. Turns are discrete, countable, and perfectly deterministic — ideal for testing. Wall-clock time introduces timing-dependent test flakiness and adds no value in a turn-based conversation model.

### Why summary-of-summaries folding?

When compaction fires and a previous summary exists, it's included in the messages being summarized. The new summary naturally folds in the old summary's content. This is the industry standard approach (LangChain, LangGraph, Claude Code). Quality degrades gradually over many cycles, and the context window is the natural bound.

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    ContextCompactor, CompactionResult, TokenEstimator,      │
    ContextPressureTrend, InboundMessage                     │
                                                             │
L0u @koi/token-estimator ───────────────────────────────┐    │
    HEURISTIC_ESTIMATOR                                 │    │
                                                        │    │
L0u @koi/errors ────────────────────────────────┐   │    │
    isContextOverflowError                      │   │    │
                                                ▼   ▼    ▼
L0u @koi/context-manager ◄─────────────────────┘───┘────┘
    imports from L0 + peer L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports L2 packages
```
