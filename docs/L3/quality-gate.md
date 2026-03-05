# @koi/quality-gate — Output Quality Assurance Bundle

Layer 3 meta-package that composes up to 3 middleware into a single
`createQualityGate()` call: **fast gate → deep validation → retry with feedback**.

## What This Enables

**Coordinated output quality with retry budget control.** Without this package,
output-verifier and feedback-loop operate independently:

1. **output-verifier** runs deterministic checks and an LLM-as-judge — but if
   it retries, feedback-loop doesn't know
2. **feedback-loop** validates and retries with error injection — but if it
   retries inside a verifier retry, model calls multiply exponentially
3. With both active and no coordination, retries can multiply: verifier
   (2 revisions) × feedback-loop (3 attempts) = **up to 6× model calls** per turn

With `@koi/quality-gate`, you get:

- **Deployment presets** (`light`, `standard`, `aggressive`) with tuned quality levels
- **Budget middleware**: caps total model calls per turn across all retry sources
- **3-layer config merge**: defaults → preset → user overrides
- **Priority-ordered composition**: verifier (385) → feedback-loop (450) → budget (999)
- **Unified handles**: access verifier stats and health snapshots through one bundle

## Quick Start

```typescript
import { createQualityGate, BUILTIN_CHECKS } from "@koi/quality-gate";
import { createKoi } from "@koi/engine";

// Light — deterministic checks only, no retries
const { middleware } = createQualityGate({ preset: "light" });

// Standard — deterministic + feedback-loop, 6 calls max (default)
const gate = createQualityGate({});

// With LLM-as-judge (user must provide modelCall)
const full = createQualityGate({
  preset: "aggressive",
  verifier: {
    deterministic: [BUILTIN_CHECKS.nonEmpty("block")],
    judge: {
      rubric: "Output must be helpful, accurate, and concise.",
      modelCall: async (prompt, signal) => myModel.generate(prompt, { signal }),
    },
  },
  feedbackLoop: {
    validators: [myCustomValidator],
    retry: { validation: { maxAttempts: 3 } },
  },
  maxTotalModelCalls: 10,
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [...full.middleware, ...otherMiddleware],
});

// Access L2 handles
full.verifier?.getStats();         // veto rate, total checks
full.feedbackLoop?.isQuarantined("tool-x");  // tool health

// Reset verifier stats between sessions
full.reset();
```

## Middleware Priority Order

| Priority | Middleware | Description |
|----------|-----------|-------------|
| 385 | output-verifier | Deterministic checks + LLM-as-judge (optional) |
| 450 | feedback-loop | Validation, retry with error injection, tool health |
| 999 | budget | Caps total model calls per turn (coordination primitive) |

## Budget Middleware

The budget middleware is the coordination primitive that prevents retry
multiplication. It sits at priority 999 (innermost) so every model call —
original or retry — passes through it.

- Counts model calls per turn (resets when `ctx.turnIndex` changes)
- Throws `KoiRuntimeError("RATE_LIMIT")` when the budget is exhausted
- Only created when `maxTotalModelCalls` is set in config

## Deployment Presets

### `light`

- verifier: deterministic non-empty check only
- No feedback-loop
- No budget cap

### `standard` (default)

- verifier: non-empty check, maxRevisions = 1
- feedback-loop: validation retry maxAttempts = 2
- Budget: 6 model calls per turn

### `aggressive`

- verifier: non-empty check, maxRevisions = 2
- feedback-loop: validation retry maxAttempts = 3
- Budget: 10 model calls per turn

**Note:** Judge config requires a `modelCall` function that only the user can
provide. Presets configure deterministic checks and retry budgets only. Users
add `judge` configuration via overrides.

## Config Resolution

The 3-layer merge works as follows:

1. **Defaults**: empty config
2. **Preset**: `QUALITY_GATE_PRESET_SPECS[preset]` fills in unset fields
3. **User overrides**: explicit config fields always win

## Return Shape

```typescript
interface QualityGateBundle {
  readonly middleware: readonly KoiMiddleware[];
  readonly verifier: VerifierHandle | undefined;
  readonly feedbackLoop: FeedbackLoopHandle | undefined;
  readonly config: ResolvedQualityGateMeta;
  readonly reset: () => void;
}

interface ResolvedQualityGateMeta {
  readonly preset: QualityGatePreset;
  readonly middlewareCount: number;
  readonly verifierEnabled: boolean;
  readonly feedbackLoopEnabled: boolean;
  readonly budgetEnabled: boolean;
}
```

## Architecture

```
@koi/quality-gate (L3)
  ├── types.ts              — QualityGateConfig, presets, bundle types
  ├── presets.ts             — QUALITY_GATE_PRESET_SPECS (frozen)
  ├── config-resolution.ts   — 3-layer merge
  ├── budget-middleware.ts    — per-turn model call budget cap
  ├── quality-gate.ts         — createQualityGate() factory
  └── index.ts               — public API surface
```

Dependencies:
- L0: `@koi/core` (types)
- L0u: `@koi/errors` (KoiRuntimeError for budget exhaustion)
- L2: `@koi/middleware-output-verifier`, `@koi/middleware-feedback-loop`
