# Stigmergic Coordination — Trail Strength & Evaporation

Agents in Koi coordinate indirectly by modifying the shared ForgeStore environment. **Trail strength** measures collective interest in a brick through decaying pheromone-like signals, enabling ant-colony–style coordination where no agent needs to know about any other agent.

---

## Why It Exists

Koi agents already coordinate through direct delegation, events, and IPC. But the most scalable coordination mechanism in nature — ant colonies, termite mounds, Wikipedia — is **stigmergy**: indirect coordination through modifications to a shared environment.

```
Without Trail Strength              With Trail Strength
──────────────────────              ───────────────────

Agents pick tools blindly           Heavily-used tools rise to the top
Unused tools never fade             Unused tools decay and drop in ranking
Each agent rediscovers everything   Collective usage patterns emerge automatically
Coordination requires messaging     Coordination happens through the environment
```

The ForgeStore already IS a shared environment — agents forge tools, others discover them — but without explicit trail strength signals and evaporation mechanics, it's a flat list with no collective intelligence.

---

## Core Concept: Trail Strength

A `number` field on `BrickArtifactBase` representing how much collective agent interest exists for a brick:

```
                 reinforcement (+0.1)
                      │
                      ▼
  ┌─────────────────────────────────────────────────┐
  │                                                 │
  │    tauMin ◄──── decay ──── trail ──── cap ────► tauMax
  │    (0.01)                 (0.5 default)         (0.95)
  │                                                 │
  └─────────────────────────────────────────────────┘
                      │
            exponential decay over time
            half-life: 7 days (configurable)
```

- **Default**: `0.5` — every new brick starts at mid-range
- **Reinforcement**: each usage adds `+0.1` (capped at `tauMax = 0.95`)
- **Decay**: exponential, `effective = stored × e^(-λ × elapsed)` where `λ = ln(2) / halfLifeMs`
- **MMAS bounds**: [0.01, 0.95] — anti-stagnation. No brick becomes permanently dominant or permanently invisible.

### Evaporation

Trail strength evaporates over time via lazy exponential decay computed at query/sort time. The stored value is the "raw" strength; effective strength is computed on read. No background timers or cron jobs needed.

---

## Layer Position

```
L0  @koi/core
    ├── BrickArtifactBase.trailStrength    ← optional number field
    ├── BrickUpdate.trailStrength           ← updatable
    ├── TrailConfig                         ← evaporation/reinforcement params
    ├── DEFAULT_TRAIL_CONFIG                ← frozen defaults
    ├── DEFAULT_TRAIL_STRENGTH              ← 0.5
    ├── ForgeQuery.orderBy: "trailStrength" ← ranking option
    └── ForgeQuery.minTrailStrength         ← filter threshold

L0u @koi/validation
    ├── computeEffectiveTrailStrength()     ← exponential decay
    ├── computeTrailReinforcement()         ← additive + cap
    ├── isTrailEvaporated()                 ← below tauMin?
    ├── sortBricks (extended)               ← trailStrength orderBy + minTrailStrength
    └── applyBrickUpdate (extended)         ← trailStrength field

L2  @koi/forge
    └── recordBrickUsage() (extended)       ← piggybacks trail reinforcement

L2  @koi/store-fs
    └── extractMetadata/computeIndexDiff    ← trail strength in memory index

L2  @koi/store-sqlite
    └── schema V3 migration                 ← trail_strength column
```

---

## How It Works

### Trail Strength Lifecycle

```
  Agent A forges brick          Agent B uses brick         Time passes (unused)
  ─────────────────────         ──────────────────         ────────────────────

  trail = 0.5 (DEFAULT)        trail = min(0.95,          effective = stored × e^(-λt)
                                  (1 - 0.05) × 0.5        = 0.6 × e^(-0.099 × 7)
                                  + 0.1)                   = 0.6 × 0.5
                                = 0.575                    ≈ 0.3
                                     │                          │
                                     ▼                          ▼
                                stored in BrickUpdate      computed at query time
                                via store.update()         (lazy — no cron needed)
```

**Step by step:**

1. Agent A forges a brick → `trailStrength` is `undefined` (defaults to `0.5` at query time)
2. Agent B calls `recordBrickUsage()` → trail reinforced: `min(tauMax, (1-ρ) × current + reinforcement)`
3. Multiple agents use the brick → trail approaches `tauMax = 0.95`
4. Usage stops → `computeEffectiveTrailStrength()` decays the stored value at query time
5. `sortBricks()` with `orderBy: "trailStrength"` ranks bricks by effective (decayed) strength
6. `minTrailStrength` filter drops bricks below a threshold

### Search and Ranking

```
store.search({
  orderBy: "trailStrength",      ← sort by effective trail (decayed)
  minTrailStrength: 0.1,         ← filter out near-evaporated bricks
  minFitnessScore: 0.01,         ← optional: combine with fitness filter
  kind: "tool",
  limit: 10,
})

Internal flow:
1. metadata index scan (in-memory) → filter by kind, tags, scope
2. compute effective trail strength for each match (lazy decay)
3. filter by minTrailStrength (post-decay)
4. filter by minFitnessScore
5. sort descending by effective trail strength
6. tiebreak alphabetically by name
7. apply limit
8. batch-load full artifacts from disk
```

---

## API Reference

### Types (L0 — @koi/core)

| Type | Description |
|------|-------------|
| `TrailConfig` | Evaporation rate, reinforcement amount, MMAS bounds, half-life |
| `DEFAULT_TRAIL_CONFIG` | Frozen defaults: `ρ=0.05, reinforcement=0.1, tauMin=0.01, tauMax=0.95, halfLifeDays=7` |
| `DEFAULT_TRAIL_STRENGTH` | `0.5` — starting trail strength for new bricks |

### Pure Functions (L0u — @koi/validation)

| Function | Signature | Description |
|----------|-----------|-------------|
| `computeEffectiveTrailStrength` | `(stored, elapsedMs, config?) → number` | Exponential decay with MMAS bounds |
| `computeTrailReinforcement` | `(current, config?) → number` | Additive reinforcement capped at tauMax |
| `isTrailEvaporated` | `(stored, elapsedMs, config?) → boolean` | True when effective ≤ tauMin |

---

## Examples

### 1. Trail Strength Computation

```typescript
import {
  computeEffectiveTrailStrength,
  computeTrailReinforcement,
} from "@koi/validation";
import { DEFAULT_TRAIL_STRENGTH } from "@koi/core";

// New brick — default trail strength
const initial = DEFAULT_TRAIL_STRENGTH; // 0.5

// After one usage
const reinforced = computeTrailReinforcement(initial);
// → min(0.95, 0.5 + 0.1) = 0.6

// After 7 days of no usage (one half-life)
const MS_PER_DAY = 86_400_000;
const effective = computeEffectiveTrailStrength(reinforced, 7 * MS_PER_DAY);
// → max(0.01, 0.6 × 0.5) = 0.3

// After 30 days of no usage
const stale = computeEffectiveTrailStrength(reinforced, 30 * MS_PER_DAY);
// → max(0.01, 0.6 × e^(-λ × 30d)) ≈ 0.01 (at tauMin floor)
```

### 2. Searching by Trail Strength

```typescript
import type { ForgeQuery } from "@koi/core";

const query: ForgeQuery = {
  kind: "tool",
  orderBy: "trailStrength",     // rank by collective interest
  minTrailStrength: 0.1,        // drop near-evaporated bricks
  limit: 5,
};

const result = await forgeStore.search(query);
if (result.ok) {
  // Top 5 tools ranked by collective agent usage patterns
  for (const brick of result.value) {
    console.log(`${brick.name} (trail: ${brick.trailStrength ?? 0.5})`);
  }
}
```

### 3. Trail Reinforcement via Usage Recording

```typescript
import { recordBrickUsage } from "@koi/forge";
import { DEFAULT_TRAIL_CONFIG } from "@koi/core";

// Trail reinforcement is automatic when config.trail is set
await recordBrickUsage(store, brickId, {
  trail: DEFAULT_TRAIL_CONFIG,
  // ... other forge config
});
// Trail strength is updated alongside fitness metrics
```

---

## Mathematical Model

### Exponential Decay

```
effective(t) = max(τ_min, stored × e^(-λ × t))

where:
  λ = ln(2) / (halfLifeDays × MS_PER_DAY)
  t = elapsed milliseconds since last update
  τ_min = 0.01 (MMAS floor)
```

### Reinforcement

```
new_strength = min(τ_max, (1 - ρ) × current + Δ)

where:
  ρ = evaporation rate (0.05)
  Δ = reinforcement amount (0.1)
  τ_max = 0.95 (MMAS cap)
```

### MMAS Anti-Stagnation

The Max-Min Ant System bounds ensure:

- **No permanent dominance**: even heavily-used bricks cap at `τ_max = 0.95`
- **No permanent invisibility**: even long-unused bricks floor at `τ_min = 0.01`
- **Exploration vs exploitation**: new bricks start at `0.5` (mid-range), giving them a fair chance before decay

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Separate field, not reusing fitness** | Trail strength measures collective interest (stigmergic signal); fitness measures individual quality (success rate, latency). Different semantics, different decay curves. |
| **Lazy decay at query time** | No background timers, no cron jobs. Matches existing fitness scoring pattern. Zero overhead when not queried. |
| **MMAS bounds** | Prevents runaway positive feedback (tauMax) and ensures all bricks remain discoverable (tauMin). |
| **Schema V3 migration** | SQLite `ALTER TABLE ADD COLUMN` is safe, non-destructive, and backward-compatible. Existing rows get `NULL` trail_strength (treated as `DEFAULT_TRAIL_STRENGTH` at query time). |

---

## Layer Compliance

```
@koi/core (L0)          ← types only, zero deps
       │
       ▼
@koi/validation (L0u)   ← pure functions, depends on L0 only
       │
       ├─────────────────────────────────────┐
       ▼                    ▼                ▼
@koi/forge (L2)    @koi/store-fs (L2)  @koi/store-sqlite (L2)
  │                    │                    │
  │ imports from:      │ imports from:      │ imports from:
  │ @koi/core          │ @koi/core          │ @koi/core
  │ @koi/validation    │ @koi/validation    │ @koi/validation
  │                    │                    │ @koi/sqlite-utils
  │ NO peer L2         │ NO peer L2         │ NO peer L2
```

All L2 packages import only from L0 and L0u — no cross-L2 dependencies. Verified by `bun run scripts/layers.ts`.

---

## Testing

~80 tests across 3 packages:

| Package | Test file | Count | Focus |
|---------|-----------|-------|-------|
| `@koi/validation` | `trail-strength.test.ts` | 47 | Decay, reinforcement, MMAS bounds, NaN guards |
| `@koi/validation` | `sort-bricks.test.ts` (+) | 10 | trailStrength orderBy, minTrailStrength, decay at sort time |
| `@koi/forge` | `usage.test.ts` (+) | 8 | Trail reinforcement piggyback on recordBrickUsage |
