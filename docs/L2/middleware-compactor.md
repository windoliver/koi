# @koi/middleware-compactor — LLM Context Compaction + Agent-Initiated Compression

`@koi/middleware-compactor` is an L2 middleware package that manages context window pressure through two complementary mechanisms:

1. **System-initiated compaction** (Layer B) — automatically summarizes old messages when token thresholds are exceeded
2. **Agent-initiated compaction** (Layer A) — exposes a `compact_context` tool so the agent can trigger compaction proactively when it sees pressure building

---

## Why It Exists

LLM agents accumulate context with every turn: user messages, tool results, model responses. Eventually the context window fills and one of three things happens:

```
Without compaction:
  Turn 1 ─► Turn 5 ─► Turn 10 ─► Turn 15 ─► BOOM (context overflow)
                                                API rejects the call

With system-only compaction:
  Turn 1 ─► ... ─► Turn 10 (75% full) ─► AUTO-COMPACT ─► Turn 11
                         │                      │
                         │                      └─ happens at arbitrary point
                         └─ agent loses working context mid-task

With agent-initiated compaction (this package):
  Turn 1 ─► ... ─► Turn 8 (51%) ─► agent sees pressure ─► COMPACT ─► Turn 9
                         │              │                      │
                         │              │                      └─ agent chose the moment
                         │              └─ "Context: 51%, ~3 turns to compaction"
                         └─ agent finishes current subtask, then compacts
```

The agent-initiated approach produces higher-quality compaction because the agent knows which context is still relevant and can time the compression at natural phase boundaries.

---

## Architecture

### Layer Position

```
L0  @koi/core                     ─ KoiMiddleware, MiddlewareBundle,
                                      ComponentProvider, Tool (types only)
L2  @koi/middleware-compactor     ─ this package (no L1 dependency)
    imports: @koi/core, @koi/errors (L0u)
```

### Internal Module Map

```
index.ts                    ← public re-exports
│
├── types.ts                ← CompactorConfig, CompactionStore, CompactionTrigger
├── compact.ts              ← LlmCompactor: threshold check + LLM summarization
├── estimator.ts            ← heuristicTokenEstimator (4 chars ≈ 1 token)
├── find-split.ts           ← optimal split point between old/recent messages
├── pair-boundaries.ts      ← user-assistant pair boundary detection
├── prompt.ts               ← summary prompt builder
├── overflow-recovery.ts    ← catch context-overflow → force-compact → retry
├── pressure-trend.ts       ← PressureTrendTracker: growth/turn + ETA
├── compactor-governance-contributor.ts  ← CONTEXT_OCCUPANCY variable
│
├── compact-context-tool.ts      ← compact_context tool factory
├── compactor-middleware.ts      ← createCompactorMiddleware() factory
├── compactor-bundle.ts          ← createCompactorBundle() = middleware + tool
│
├── memory-compaction-store.ts   ← in-memory CompactionStore
└── descriptor.ts                ← BrickDescriptor for manifest resolution
```

---

## How It Works

### System Prompt Injection (Every Turn)

The middleware injects a live status line into every model call via `describeCapabilities`:

```
[compactor] Context: 62% (124K/200K), 5K/turn, ~8 turns to compaction.
            Use compact_context tool to trigger early compaction.
```

The agent sees this pressure reading and can decide to act.

### Signal Mechanism

```
Turn N:                                     Turn N+1:
┌──────────┐    ┌─────────────┐            ┌──────────────────┐
│ wrapModel│───►│ LLM sees    │            │ wrapModelCall    │
│ Call     │    │ "Context:   │            │ checks flag:     │
│ (normal) │    │  85%..."    │            │ forceCompactNext │
└──────────┘    └──────┬──────┘            │ = true!          │
                       │                   │                  │
                       ▼                   │ → forceCompact() │
                ┌──────────────┐           │ → reset flag     │
                │ LLM decides  │           │ → proceed with   │
                │ to call      │           │   compacted msgs │
                │ compact_ctx  │           └──────────────────┘
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │ wrapToolCall │
                │ executes     │
                │ tool:        │
                │ sets flag:   │
                │ forceCompact │
                │ Next = true  │
                └──────────────┘
```

The one-shot flag ensures:
- Tool call sets `forceCompactNext = true`
- Next `wrapModelCall` or `wrapModelStream` consumes it (resets to `false`)
- No permanent state change — if the model doesn't make another call, nothing happens

### Before vs After

```
                      BEFORE (agent blind to pressure)

Turn 1   Turn 2   Turn 3   Turn 4   Turn 5   Turn 6   Turn 7
┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐
│ 8% │  │22% │  │38% │  │51% │  │65% │  │78% │  │92% │
│    │  │    │  │    │  │    │  │    │  │    │  │████│
│    │  │    │  │    │  │    │  │    │  │████│  │████│
│    │  │    │  │    │  │    │  │████│  │████│  │████│
│    │  │    │  │    │  │████│  │████│  │████│  │████│
│    │  │    │  │████│  │████│  │████│  │████│  │████│
│    │  │████│  │████│  │████│  │████│  │████│  │████│
│████│  │████│  │████│  │████│  │████│  │████│  │████│
└────┘  └────┘  └────┘  └────┘  └────┘  └────┘  └────┘

Agent sees: (nothing)    Auto-compact at 75% → agent loses context mid-task


                     AFTER (agent sees + acts on pressure)

Turn 1   Turn 2   Turn 3   Turn 4   Turn 5   Turn 6   Turn 7
┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐
│ 8% │  │22% │  │38% │  │51% │  │12% │  │25% │  │38% │
│    │  │    │  │    │  │    │  │    │  │    │  │    │
│    │  │    │  │    │  │    │  │    │  │    │  │████│
│    │  │    │  │    │  │    │  │    │  │████│  │████│
│    │  │    │  │    │  │████│  │    │  │████│  │████│
│    │  │    │  │████│  │████│  │    │  │████│  │████│
│    │  │████│  │████│  │████│  │████│  │████│  │████│
│████│  │████│  │████│  │████│  │████│  │████│  │████│
└────┘  └────┘  └────┘  └────┘  └────┘  └────┘  └────┘
                           │
                           ▼
               Agent sees "51%, ~3 turns left"
               Agent calls compact_context
               → 51% drops to 12%
               Agent continues with room to work
```

---

## Bundle Architecture

The `MiddlewareBundle` pattern packages middleware + tool provider for cohesive features:

```
createCompactorBundle(config)
│
├──► CompactorMiddleware          (registered as middleware)
│    ├── wrapModelCall            reads forceCompactNext flag
│    ├── wrapModelStream          reads forceCompactNext flag
│    ├── describeCapabilities     "...Use compact_context tool..."
│    ├── scheduleCompaction()  ◄──── shared closure ────┐
│    └── formatOccupancy()     ◄──── shared closure ──┐ │
│                                                      │ │
└──► ComponentProvider            (registered as ECS)  │ │
     └── tool:compact_context                          │ │
          ├── descriptor.name = "compact_context"      │ │
          ├── trustTier = "verified"                   │ │
          └── execute() ───────────────────────────────┘ │
                calls deps.formatOccupancy() ────────────┘
                calls deps.scheduleCompaction() ──────────┘
```

Middleware and tool registration are separate concerns. The bundle is a convenience
factory that returns both, registered separately — like Rust trait composition
(`impl Middleware + ToolProvider`) or Passport.js exporting both `initialize()` and `routes()`.

---

## API

### `createCompactorMiddleware(config)`

Creates the middleware only (no tool). Use when you want system-initiated compaction
without exposing the tool to the agent.

```typescript
import { createCompactorMiddleware } from "@koi/middleware-compactor";

const mw = createCompactorMiddleware({
  summarizer: modelCall,          // LLM handler for generating summaries
  contextWindowSize: 200_000,     // default
  trigger: { tokenFraction: 0.75 }, // compact at 75% occupancy
  preserveRecent: 4,              // always keep last 4 messages
  toolEnabled: true,              // mention compact_context in describeCapabilities
});
```

Returns `CompactorMiddleware` extending `KoiMiddleware` with:
- `governanceContributor` — declares `CONTEXT_OCCUPANCY` variable
- `pressureTrend()` — returns `ContextPressureTrend` (growth/turn, ETA)
- `scheduleCompaction()` — sets the one-shot force-compact flag
- `formatOccupancy()` — returns human-readable string like `"Context: 62% (124K/200K)"`

### `createCompactorBundle(config)`

Creates both middleware and tool provider. The bundle always sets `toolEnabled: true`.

```typescript
import { createCompactorBundle } from "@koi/middleware-compactor";

const bundle = createCompactorBundle({
  summarizer: modelCall,
  contextWindowSize: 200_000,
});

// Register both parts separately
const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [bundle.middleware],
  providers: [...bundle.providers, governanceProvider],
});
```

Returns `CompactorBundle` extending `MiddlewareBundle`:
- `middleware` — the `CompactorMiddleware` instance
- `providers` — array with one `ComponentProvider` (attaches `tool:compact_context`)

### `createCompactContextTool(deps)`

Low-level factory for the tool alone. Used internally by the bundle; exposed for
advanced wiring.

```typescript
import { createCompactContextTool } from "@koi/middleware-compactor";

const tool = createCompactContextTool({
  scheduleCompaction: () => { /* set your flag */ },
  formatOccupancy: () => "Context: 42% (84K/200K)",
});

// tool.descriptor.name === "compact_context"
// tool.trustTier === "verified"
// tool.execute({}) → "Compaction scheduled for next model call. Current Context: 42%..."
```

### `CompactorConfig`

```typescript
interface CompactorConfig {
  readonly summarizer: ModelHandler;
  readonly summarizerModel?: string;
  readonly contextWindowSize?: number;       // default: 200_000
  readonly trigger?: CompactionTrigger;      // default: { tokenFraction: 0.75 }
  readonly preserveRecent?: number;          // default: 4
  readonly maxSummaryTokens?: number;        // default: 1000
  readonly tokenEstimator?: TokenEstimator;
  readonly promptBuilder?: (messages, maxTokens) => string;
  readonly archiver?: CompactionArchiver;
  readonly store?: CompactionStore;
  readonly overflowRecovery?: OverflowRecoveryConfig;
  readonly toolEnabled?: boolean;            // mention tool in describeCapabilities
}
```

### `MiddlewareBundle` (L0 type)

```typescript
// Defined in @koi/core/middleware.ts
interface MiddlewareBundle {
  readonly middleware: KoiMiddleware;
  readonly providers: readonly ComponentProvider[];
}
```

---

## Examples

### 1. Direct Wiring with `createKoi`

```typescript
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import {
  COMPACTOR_GOVERNANCE,
  createCompactorBundle,
} from "@koi/middleware-compactor";

const bundle = createCompactorBundle({
  summarizer: modelCall,
  contextWindowSize: 200_000,
});

// Governance provider makes CONTEXT_OCCUPANCY visible to GovernanceController
const governanceProvider = {
  name: "compactor-governance",
  async attach() {
    return new Map([[COMPACTOR_GOVERNANCE, bundle.middleware.governanceContributor]]);
  },
};

const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "..." } },
  adapter: createLoopAdapter({ modelCall, maxTurns: 25 }),
  middleware: [bundle.middleware],
  providers: [...bundle.providers, governanceProvider],
});
```

### 2. With Pi Adapter

```typescript
import { createPiAdapter } from "@koi/engine-pi";
import { createCompactorBundle } from "@koi/middleware-compactor";

const bundle = createCompactorBundle({ summarizer: modelCall });
const adapter = createPiAdapter({ model: "anthropic:claude-sonnet-4-5-20250929" });

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [bundle.middleware],
  providers: [...bundle.providers],
});
```

### 3. Middleware Only (No Tool)

When you want automatic compaction without giving the agent a tool:

```typescript
import { createCompactorMiddleware } from "@koi/middleware-compactor";

const mw = createCompactorMiddleware({
  summarizer: modelCall,
  overflowRecovery: { maxRetries: 2 },
  store: createMemoryCompactionStore(),
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [mw],
});
```

### 4. Reading Pressure Trend

```typescript
const bundle = createCompactorBundle({ summarizer: modelCall });

// After a few turns...
const trend = bundle.middleware.pressureTrend();
console.log(`Growth: ${trend.growthPerTurn} tokens/turn`);
console.log(`ETA: ${trend.estimatedTurnsToCompaction} turns to compaction`);
console.log(`Samples: ${trend.sampleCount}`);

// Programmatic access to occupancy
const occupancy = bundle.middleware.formatOccupancy();
// → "Context: 62% (124K/200K)"
```

---

## Features

### System-Initiated Compaction (Layer B)

Triggers when any threshold is met:

| Trigger | Default | Description |
|---------|---------|-------------|
| `tokenFraction` | 0.75 | Fraction of contextWindowSize |
| `tokenCount` | — | Absolute token threshold |
| `messageCount` | — | Message count threshold |

Compaction flow: estimate tokens → check triggers → find split point → LLM summarize → replace old messages with summary.

### Overflow Recovery

Catches `context_length_exceeded` errors from the API, force-compacts, and retries:

```typescript
const mw = createCompactorMiddleware({
  summarizer: modelCall,
  overflowRecovery: { maxRetries: 2 },
});
```

### Session Restore

Persists compaction results across session restarts:

```typescript
import { createMemoryCompactionStore } from "@koi/middleware-compactor";

const mw = createCompactorMiddleware({
  summarizer: modelCall,
  store: createMemoryCompactionStore(),
});
// onSessionStart loads previous result; first model call prepends it
```

### Governance Integration

The `CONTEXT_OCCUPANCY` governance variable is tracked via `GovernanceVariableContributor`:

```typescript
const snapshot = await governanceController.snapshot();
const occupancy = snapshot.readings.find(r => r.name === "context_occupancy");
// { current: 124000, limit: 200000, utilization: 0.62 }
```

### Pressure Trend Tracking

After 2+ model calls, the middleware estimates growth rate and turns until compaction:

```
Context: 62% (124K/200K), 5K/turn, ~8 turns to compaction
```

---

## Priority and Middleware Ordering

`@koi/middleware-compactor` has `priority: 225`:

```
priority: 200  @koi/middleware-pay        (budget check first)
priority: 225  @koi/middleware-compactor   ← THIS (compact before context editing)
priority: 250  context editing middleware
priority: 300  @koi/middleware-audit       (audit all calls)
```

---

## Performance Properties

| Operation | Cost | Notes |
|-----------|------|-------|
| Token estimation | O(messages) | Heuristic: 4 chars ≈ 1 token |
| Threshold check | O(1) | Compare estimated tokens vs threshold |
| Compaction | O(messages) + 1 LLM call | Only when threshold exceeded |
| Force-compact (tool) | O(messages) + 1 LLM call | One-shot, next model call only |
| Pressure trend | O(1) | Rolling window of last 10 samples |
| `describeCapabilities` | O(1) | String concatenation from cached values |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    KoiMiddleware, MiddlewareBundle, ComponentProvider,      │
    Tool, ContextPressureTrend, GovernanceVariableContributor│
                                                             │
L0u @koi/errors ────────────────────────────────────────┐    │
    isContextOverflowError                              │    │
                                                        ▼    ▼
L2  @koi/middleware-compactor ◄─────────────────────────┘────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external runtime dependencies
```

Dev-only dependency (`@koi/test-utils`) is used in tests but is not a runtime import.
