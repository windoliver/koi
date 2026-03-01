# @koi/middleware-degenerate — Variant Selection & Failover for Degenerate Tools

Maintains 2-3 structurally different implementations of the same capability and automatically selects the best one at runtime. If the primary fails, the system tries alternatives — no agent intervention needed.

---

## Why It Exists

The resolver chain assumes one winner per query. If that tool breaks, the agent is stuck. There's no mechanism to maintain multiple structurally different implementations of the same tool interface, selected by fitness or context.

This limits **robustness** (uncorrelated failures across implementations) and **evolvability** (variants can't compete on fitness).

---

## What This Enables

```
BEFORE: single point of failure per capability
═════════════════════════════════════════════════

  LLM calls "search" ──▶ search-api ──▶ API down ──▶ FAIL
                          (only impl)                 Agent stuck.

  One tool per capability. If it breaks, the agent has no fallback.


AFTER: degenerate variants with automatic failover
═══════════════════════════════════════════════════

  LLM calls "search" ──▶ middleware intercepts
                              │
                              ▼
                    ┌─────────────────┐
                    │ Variant Selector │
                    │ (fitness/rr/ctx) │
                    └────────┬────────┘
                             │
                   ┌─────────┼─────────┐
                   ▼         ▼         ▼
              search-api  search-scrape search-cache
              (primary)   (failover 1)  (failover 2)
                   │
                   ▼
              API down? ──▶ try search-scrape ──▶ SUCCESS
                            (automatic failover)

  Multiple implementations compete on fitness. Failures trigger failover.
```

---

## Architecture

**Layer**: L2 (feature package)
**Depends on**: `@koi/core` (L0), `@koi/errors` (L0u), `@koi/validation` (L0u), `@koi/variant-selection` (L0u)
**Implements**: `KoiMiddleware` contract from `@koi/core`

### Package Map

```
@koi/variant-selection/src/        (L0u — pure selection algorithms)
├── types.ts                       # VariantEntry, VariantPool, SelectionContext
├── select-by-fitness.ts           # Weighted random by fitness score
├── select-round-robin.ts          # Deterministic rotation
├── select-by-context.ts           # User-provided matcher ranks variants
├── select-random.ts               # Uniform random (A/B testing)
├── select.ts                      # Strategy dispatcher
└── execute-with-failover.ts       # Core failover loop with circuit breakers

@koi/middleware-degenerate/src/    (L2 — middleware integration)
├── types.ts                       # DegenerateMiddlewareConfig, DegenerateHandle
├── config.ts                      # Config validation
├── build-pools.ts                 # Queries ForgeStore, builds variant pools
└── degenerate-middleware.ts       # createDegenerateMiddleware() factory
```

### Middleware Priority

```
450  feedback-loop     ← health tracking, quarantine, fitness flush
455  forge-demand      ← detect capability gaps, trigger forging
460  degenerate        ← variant selection + failover (THIS)
475  event-trace       ← telemetry
```

The degenerate middleware sits **after** feedback-loop (so health signals are recorded for the variant that actually ran) and **after** forge-demand (so demand signals can trigger variant forging). It sits **before** event-trace (so telemetry captures variant selection events).

---

## How It Works

### 1. Manifest Declaration

Agents declare per-capability degeneracy in `koi.yaml`:

```yaml
degeneracy:
  search:
    selectionStrategy: fitness    # fitness | round-robin | context-match | random
    minVariants: 2
    maxVariants: 3
    failoverEnabled: true
  translate:
    selectionStrategy: round-robin
    failoverEnabled: false
```

### 2. Variant Discovery

Variants are bricks tagged with `capability:<name>`. At session start, the middleware queries:

```
forgeStore.search({ kind: "tool", lifecycle: "active", tags: ["capability:search"] })
```

This returns all active tool bricks for the capability. They're scored by `computeBrickFitness()` and capped at `maxVariants`.

### 3. Selection Strategies

| Strategy | How it picks | Best for |
|----------|-------------|----------|
| `fitness` | Weighted random by fitness score | Production (best variant gets most traffic) |
| `round-robin` | Deterministic rotation | Data collection (equal traffic to all variants) |
| `context-match` | User-provided matcher ranks by input | Specialized routing (URL→scraper, query→API) |
| `random` | Uniform random | A/B testing |

### 4. Failover Flow

```
wrapToolCall(request)
    │
    ├── toolToCapability.get(toolId) → capability?
    │   └── not found → pass through to next(request)
    │
    ├── selectVariant(pool, breakers, strategy)
    │   └── returns primary + alternatives
    │
    ├── execute primary
    │   ├── success → return result + attempt metadata
    │   └── failure → record on circuit breaker
    │       │
    │       ├── failoverEnabled = false → throw
    │       │
    │       └── for each alternative (skip open breakers):
    │           ├── execute alternative
    │           ├── success → return result + all attempts
    │           └── failure → continue to next
    │
    └── all failed → onAllVariantsFailed callback, throw last error
```

### 5. Circuit Breakers

Each variant has its own circuit breaker (from `@koi/errors`). State machine:

```
CLOSED (healthy) ──failures exceed threshold──▶ OPEN (broken)
                                                    │
                                              cooldown expires
                                                    │
                                                    ▼
                                              HALF_OPEN (probing)
                                                    │
                                          ┌─────────┴─────────┐
                                          │                     │
                                     probe succeeds        probe fails
                                          │                     │
                                          ▼                     ▼
                                       CLOSED                 OPEN
```

Open breakers are skipped during failover. If **all** breakers are open, the system degrades gracefully and tries anyway.

---

## Usage

```typescript
import { createDegenerateMiddleware } from "@koi/middleware-degenerate";

const handle = createDegenerateMiddleware({
  forgeStore,
  createToolExecutor: (brick) => brickToToolHandler(brick),
  capabilityConfigs: new Map([
    ["search", { selectionStrategy: "fitness", minVariants: 2, maxVariants: 3, failoverEnabled: true }],
  ]),
  onFailover: (attempt, nextId) => {
    console.log(`Failover: ${attempt.variantId} failed, trying ${nextId}`);
  },
  onAllVariantsFailed: (capability, attempts) => {
    console.log(`All ${capability} variants failed after ${attempts.length} attempts`);
  },
});

// Register middleware
agent.use(handle.middleware);

// Inspect state
handle.getVariantPool("search");     // current pool
handle.getAttemptLog("search");      // recent attempts
```

---

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `selectionStrategy` | `"fitness" \| "round-robin" \| "context-match" \| "random"` | `"fitness"` | How to pick the primary variant |
| `minVariants` | `number` | `1` | Minimum active implementations |
| `maxVariants` | `number` | `3` | Cap to prevent bloat |
| `failoverEnabled` | `boolean` | `true` | Auto-fallback to next variant on failure |

Validated at manifest parse time via Zod schema. `minVariants` must be `<= maxVariants`.

---

## Design Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Resolver interface | Unchanged — middleware wraps it | No breaking changes to existing resolver chain |
| 2 | Selection logic | Separate L0u package | Pure functions, reusable by model-router |
| 3 | Variant grouping | `capability:<name>` tags on bricks | No new fields needed on BrickArtifact |
| 4 | Alternative execution | Injected `createToolExecutor` factory | Avoids L2-to-L2 imports |
| 5 | Hot path cost | Compute fitness every call | Trivial cost (~microseconds), always fresh |
| 6 | Circuit breaker memory | In-memory, disposed on session end | No persistence needed for per-session state |

---

## See Also

- `@koi/variant-selection` — L0u selection algorithms (no middleware coupling)
- `@koi/middleware-feedback-loop` — health tracking + quarantine (runs before degenerate)
- `@koi/forge-demand` — demand-triggered forging (can create new variants)
- `@koi/validation` — `computeBrickFitness()` scoring function
