# Differential Mutation Pressure — Fitness-Based Forge Protection

Maps brick fitness scores to mutation pressure zones, freezing high-performers from replacement while amplifying experimentation pressure on low-performers. Prevents crystallization and demand-triggered forging from replacing proven bricks in the same capability space.

---

## Why It Exists

Koi tracks brick fitness (success rate, error rate, latency, recency) and can demote low-performers. But nothing protects high-fitness bricks from being replaced by crystallization or demand-triggered forging in the same capability space.

Without mutation pressure:

- **A brick with 99% success rate** can be silently replaced by a new forge in the same tag space
- **No evolutionary signal** — the system treats all capability spaces equally regardless of incumbent quality
- **Wasted compute** — forging + verification cycles spent replacing bricks that already work well

With mutation pressure:

- **High-fitness bricks are frozen** — forge attempts in their capability space are blocked
- **Low-fitness bricks attract replacement** — the system amplifies experimentation in weak spots
- **Fail-open** — if the store is unavailable, forging proceeds normally (infra failures don't block creation)

---

## How It Works

### Pressure Zones

Fitness scores map to four mutation pressure zones:

```
Fitness Score    Zone             Behavior
─────────────────────────────────────────────────────
  > 0.9         "frozen"         Block forge in overlapping capability space
  0.5 – 0.9    "stable"         Normal (no interference)
  0.2 – 0.5    "experimental"   Increased experimentation
  < 0.2         "aggressive"     Amplified replacement search
```

### Capability Space Matching

Capability space is defined by brick `tags`. The check uses **AND-subset matching** (reuses `matchesBrickQuery` from `@koi/validation`): a brick overlaps if it contains all the forge request's tags.

### Pipeline Integration

```
┌─────────────┐    ┌─────────────────────┐    ┌──────────────┐    ┌──────────┐
│  Parse Input │───▶│  Mutation Pressure   │───▶│  Verification │───▶│  Save    │
│              │    │  Check               │    │  Pipeline     │    │          │
└─────────────┘    └─────────────────────┘    └──────────────┘    └──────────┘
                          │
                          ▼
                   Query store for active
                   bricks with same tags
                          │
                          ▼
                   Compute max fitness
                   among incumbents
                          │
                          ▼
                   Map to pressure zone
                          │
                    ┌─────┴─────┐
                    │  frozen?  │
                    └─────┬─────┘
                   yes    │    no
                    ▼     │     ▼
              BLOCK with  │  ALLOW
              governance  │  (return zone)
              error       │
```

The check runs **before verification** — no expensive sandbox/test cycles wasted when the capability space is protected.

---

## Configuration

Mutation pressure is **opt-in** (`enabled: false` by default).

```typescript
import { createDefaultForgeConfig } from "@koi/forge";

const config = createDefaultForgeConfig({
  mutationPressure: {
    enabled: true,
    frozenThreshold: 0.9,    // fitness > 0.9 → frozen
    stableThreshold: 0.5,    // fitness >= 0.5 → stable
    experimentalThreshold: 0.2, // fitness >= 0.2 → experimental
                                // fitness < 0.2 → aggressive
  },
});
```

### Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable mutation pressure checks |
| `frozenThreshold` | `number` | `0.9` | Fitness strictly above this → frozen |
| `stableThreshold` | `number` | `0.5` | Fitness at or above this → stable |
| `experimentalThreshold` | `number` | `0.2` | Fitness at or above this → experimental, below → aggressive |

---

## API Reference

### L0 Types (`@koi/core`)

| Export | Kind | Description |
|--------|------|-------------|
| `MutationPressure` | Type | `"frozen" \| "stable" \| "experimental" \| "aggressive"` |
| `MutationPressurePolicy` | Interface | Threshold config: `frozenThreshold`, `stableThreshold`, `experimentalThreshold` |
| `DEFAULT_MUTATION_PRESSURE_POLICY` | Constant | Default thresholds (0.9 / 0.5 / 0.2) |

### L0u Pure Scoring (`@koi/validation`)

| Export | Kind | Description |
|--------|------|-------------|
| `computeMutationPressure(fitnessScore, policy?)` | Function | Maps fitness → pressure zone. Pure, no I/O. |

### L2 Forge Check (`@koi/forge`)

| Export | Kind | Description |
|--------|------|-------------|
| `checkMutationPressure(tags, store, config, nowMs)` | Function | Queries store, finds max fitness, returns zone or frozen error |
| `MutationPressureResult` | Interface | `{ pressure, maxFitness, dominantBrickId }` |
| `MutationPressureConfig` | Interface | Forge config section for mutation pressure |

### Error Code

| Code | Stage | When |
|------|-------|------|
| `MUTATION_PRESSURE_FROZEN` | `governance` | Capability space protected by high-fitness incumbent |

---

## Auto-Forge Integration

The auto-forge middleware (crystallization → forge pipeline) supports mutation pressure via a `beforeSave` hook:

```typescript
import { createAutoForgeMiddleware } from "@koi/crystallize";

const middleware = createAutoForgeMiddleware({
  crystallizeHandle,
  forgeStore,
  scope: "agent",

  // L3 wiring injects mutation pressure check
  beforeSave: async (brick) => {
    const result = await checkMutationPressure(
      brick.tags,
      forgeStore,
      config.mutationPressure,
      Date.now(),
    );
    return result.ok; // false = skip save (frozen)
  },
});
```

This preserves L2 isolation — `@koi/crystallize` never imports from `@koi/forge`. The L3 meta-package wires the check via callback injection.

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Opt-in (`enabled: false`) | Non-breaking. Teams adopt when ready. |
| Strictly `>` for frozen threshold | 0.9 exactly = stable (benefit of the doubt to forge attempts) |
| Fail-open on store errors | Infra failures should not block creation |
| No incumbents = stable | Empty capability space always allows forging |
| Check before verification | Avoids wasted sandbox/test cycles on frozen spaces |
| `beforeSave` hook on auto-forge | Preserves L2 isolation without L2→L2 import |
| AND-subset tag matching | Reuses existing `matchesBrickQuery` semantics |

---

## Testing

```bash
# L0u pure scoring
bun test packages/validation/src/mutation-pressure.test.ts

# L2 capability space check
bun test packages/forge/src/mutation-pressure-check.test.ts

# Governance integration
bun test packages/forge/src/governance.test.ts

# Auto-forge middleware
bun test packages/crystallize/src/auto-forge-middleware.test.ts
```

### Test Coverage

| Test File | Cases | Coverage |
|-----------|-------|----------|
| `mutation-pressure.test.ts` | 12 | Zone boundaries, custom policy, edge cases (0, 1.0) |
| `mutation-pressure-check.test.ts` | 11 | Empty tags, no overlap, frozen/stable/aggressive, multiple bricks, no fitness, fail-open, custom thresholds |
| `governance.test.ts` | 2 new | Config absent, config disabled |

---

## Layer Compliance

```
L0  @koi/core
    └── MutationPressure, MutationPressurePolicy, DEFAULT_MUTATION_PRESSURE_POLICY
         (types + frozen constant only)

L0u @koi/validation
    └── computeMutationPressure()
         (pure function, imports only @koi/core)

L2  @koi/forge
    ├── MutationPressureConfig, checkMutationPressure()
    │    (imports @koi/core + @koi/validation only)
    └── MUTATION_PRESSURE_FROZEN error code

L2  @koi/crystallize
    └── beforeSave hook on AutoForgeConfig
         (no L2→L2 import, callback injection)
```
