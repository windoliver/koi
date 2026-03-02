# @koi/forge-exaptation — Exaptation (Purpose Drift) Detection

`@koi/forge-exaptation` is an L2 middleware package that detects when bricks (tools, skills, agents) are used beyond their original purpose. When multiple agents repurpose the same tool for divergent purposes, the middleware emits an `ExaptationSignal` — a cue to generalize the interface or forge a new specialized brick.

---

## Why It Exists

Bricks are created with a stated purpose (their description), but real-world usage drifts. A "file-reader" tool starts being used for config parsing, log analysis, and data extraction. This latent generality goes undetected — the tool works, so nobody notices it's doing three jobs.

```
Before:
  tool "file-reader" described as "Read files from the filesystem"
  agent-A uses it to parse config → works fine
  agent-B uses it to analyze logs → works fine
  agent-C uses it to extract CSV data → works fine
  Problem: nobody knows this tool is 3 tools in a trench coat

After (with exaptation detection):
  middleware observes each usage context vs stated purpose
  Jaccard distance shows persistent divergence across agents
  ExaptationSignal emitted → forge pipeline can:
    - generalize the tool's interface
    - fork it into specialized variants
    - update the description to match actual usage
```

The term **exaptation** comes from evolutionary biology: a trait that evolved for one purpose but gets co-opted for another (feathers evolved for warmth, then flight). Detecting this in bricks reveals where the system is organically adapting.

---

## What This Feature Enables

1. **Automatic interface evolution** — Signals when a tool's stated purpose no longer matches how agents actually use it. Without this, interfaces fossilize even as usage patterns change.

2. **Principled brick splitting** — Instead of guessing when to split a tool into specialized variants, the system provides evidence: which agents, how divergent, how often. Data-driven forging decisions.

3. **Cross-agent pattern discovery** — A single agent repurposing a tool is noise. Multiple agents independently converging on the same repurposing is a pattern. The `minDivergentAgents` threshold (default: 2) separates signal from noise.

4. **Self-describing system** — Each `ExaptationSignal` carries full evidence: the original description, observed contexts, divergence score, and agent count. The signal is fat and self-contained — consumers don't need to query back for context.

---

## Architecture

### Layer position

```
L0  @koi/core               ─ ExaptationKind, ExaptationSignal, UsagePurposeObservation
L0u @koi/errors              ─ error types
L0u @koi/validation          ─ validateWith for config validation
L2  @koi/forge-exaptation    ─ this package (depends on L0 + L0u only)
```

### Signal flow

```
┌──────────────────────────────────────────────────────────────┐
│                 Exaptation Detection Pipeline                 │
│                                                               │
│   wrapModelCall (priority 460):                               │
│     ├── capture model response text (truncated to 200 words)  │
│     └── cache tool descriptions from ModelRequest.tools       │
│                                                               │
│   wrapToolCall (priority 460):                                │
│     ├── tokenize cached tool description + model context      │
│     ├── compute Jaccard distance (divergence score)           │
│     ├── store UsagePurposeObservation in ring buffer          │
│     └── run detectPurposeDrift on accumulated observations    │
│         └── all criteria met → emit ExaptationSignal          │
│                                                               │
│   Observation ring buffer (per brick, max 30):                │
│     └── bounded memory, oldest observations evicted           │
│                                                               │
│   Signal queue (bounded, max 10):                             │
│     ├── cooldown per brick (default: 60s)                     │
│     ├── confidence scoring via computeExaptationConfidence    │
│     └── dismiss(signalId) clears signal + cooldown            │
│                                                               │
│   Consumer (not yet wired):                                   │
│     └── auto-forge-middleware could read signals to trigger    │
│         interface generalization or brick splitting            │
└──────────────────────────────────────────────────────────────┘
```

### Module map

```
forge-exaptation/src/
├── types.ts              ─ ExaptationConfig, ExaptationHandle, ExaptationThresholds
├── divergence.ts         ─ Jaccard tokenization + distance scoring (pure)
├── heuristics.ts         ─ detectPurposeDrift detection logic (pure)
├── confidence.ts         ─ Confidence scoring algorithm (pure)
├── exaptation-detector.ts ─ Middleware factory (createExaptationDetector)
├── config.ts             ─ Zod validation, defaults, createDefaultExaptationConfig
└── index.ts              ─ Public exports
```

---

## How Detection Works

### Step 1: Observe

On every model call, the middleware captures the response text (what the model said before calling a tool) and caches tool descriptions from the request.

### Step 2: Measure divergence

On every tool call, it tokenizes both the tool's description and the captured context, then computes **Jaccard distance**:

```
Tool description: "Read files from the filesystem and return contents"
  → tokens: { read, files, filesystem, return, contents }

Model context: "analyze network traffic patterns and detect anomalies"
  → tokens: { analyze, network, traffic, patterns, detect, anomalies }

Intersection: { }  (0 shared)
Union: { read, files, filesystem, return, contents, analyze, network, traffic, patterns, detect, anomalies }  (11 total)

Jaccard distance = 1 - 0/11 = 1.0  (maximum divergence)
```

### Step 3: Accumulate

Each observation is stored in a per-brick ring buffer (max 30 entries). The observation records the context text, agent ID, divergence score, and timestamp.

### Step 4: Detect

`detectPurposeDrift` checks three criteria:

| Criterion | Default threshold | Purpose |
|-----------|------------------|---------|
| Minimum observations | 5 | Enough data to be meaningful |
| Average divergence | > 0.7 | Usage is substantially different from description |
| Minimum divergent agents | 2 | Multiple agents show the pattern (not just one outlier) |

All three must be met. This conservative approach minimizes false positives.

### Step 5: Score and emit

When drift is detected, confidence is computed:

```
confidence = divergence × agentMultiplier × observationMultiplier × weight

agentMultiplier = min(agentCount / minDivergentAgents, 2)     ─ caps at 2x
observationMultiplier = min(observationCount / minObservations, 2)  ─ caps at 2x
weight = 0.8 (default)

Result clamped to [0, 1]
```

The signal is emitted with full evidence (stated purpose, observed contexts, scores).

---

## API Reference

### `createExaptationDetector(config)`

Factory that returns an `ExaptationHandle` bundling the middleware and signal query API.

```typescript
import { createExaptationDetector } from "@koi/forge-exaptation";

const handle = createExaptationDetector({
  cooldownMs: 60_000,
  thresholds: {
    minObservations: 5,
    divergenceThreshold: 0.7,
    minDivergentAgents: 2,
    confidenceWeight: 0.8,
  },
  onSignal: (signal) => console.log("Exaptation:", signal.brickName, signal.divergenceScore),
  onDismiss: (id) => console.log("Dismissed:", id),
});

// Register the middleware
agent.use(handle.middleware);

// Query pending signals
const signals = handle.getSignals();
handle.dismiss(signals[0]?.id ?? "");
```

### `ExaptationHandle`

```
readonly middleware: KoiMiddleware                   ─ Register with the agent
readonly getSignals: () => ExaptationSignal[]        ─ Current pending signals
readonly dismiss: (signalId: string) => void         ─ Remove signal + reset cooldown
readonly getActiveSignalCount: () => number          ─ Pending signal count
```

### `validateExaptationConfig(raw)`

Validates unknown input into a fully resolved config with defaults.

```typescript
import { validateExaptationConfig } from "@koi/forge-exaptation";

const result = validateExaptationConfig(rawInput);
if (result.ok) {
  const config = result.value; // ExaptationConfig with all defaults resolved
}
```

### `createDefaultExaptationConfig(overrides?)`

Creates a config with sensible defaults, optionally merged with overrides.

### Pure functions (independently usable)

```typescript
import { tokenize, computeJaccardDistance, truncateToWords } from "@koi/forge-exaptation";
import { detectPurposeDrift } from "@koi/forge-exaptation";
import { computeExaptationConfidence } from "@koi/forge-exaptation";
```

---

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cooldownMs` | `number` | `60_000` | Cooldown between signals for the same brick (ms) |
| `maxPendingSignals` | `number` | `10` | Bounded signal queue size |
| `maxObservationsPerBrick` | `number` | `30` | Ring buffer size per brick |
| `maxContextWords` | `number` | `200` | Max words kept from model response |
| `thresholds.minObservations` | `number` | `5` | Minimum observations before detection |
| `thresholds.divergenceThreshold` | `number` | `0.7` | Jaccard distance threshold (0–1) |
| `thresholds.minDivergentAgents` | `number` | `2` | Minimum distinct agents showing drift |
| `thresholds.confidenceWeight` | `number` | `0.8` | Weight applied to confidence score |
| `onSignal` | `(signal) => void` | `undefined` | Callback when signal emitted |
| `onDismiss` | `(id) => void` | `undefined` | Callback when signal dismissed |
| `clock` | `() => number` | `Date.now` | Clock function (testable) |

---

## Accuracy and Limitations

Jaccard keyword overlap is a **coarse lexical measure** — deliberately chosen for Phase 1:

| Strength | Limitation |
|----------|-----------|
| Zero dependencies (no model files) | No semantic understanding |
| Sub-millisecond latency | Synonyms treated as different ("read" vs "load") |
| Simple to reason about | Shared words mask different purposes ("search code" vs "search logs") |
| Conservative thresholds reduce false positives | May miss subtle drift |

The architecture supports swapping `computeJaccardDistance` for embedding-based cosine similarity in the future — the `divergenceScore` interface (0–1 number) stays the same.

---

## Integration Status

**Not yet wired to auto-forge.** The `ExaptationHandle` API mirrors `ForgeDemandHandle`, but `auto-forge-middleware` in `@koi/crystallize` doesn't consume exaptation signals yet. Future integration would add an `exaptationHandle` config field following the same pattern as `demandHandle`.

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Jaccard over embeddings** | Zero deps, sub-ms latency, good enough for obvious drift. Swap later if needed. |
| **Separate L2 package** (not merged into forge-demand) | Different signal type, different detection mechanism. Rule of Three — share code only after 3rd occurrence. |
| **Handle pattern** (middleware + query API) | Matches `ForgeDemandHandle` precedent. |
| **Two-hook approach** (wrapModelCall + wrapToolCall) | Model response captured first, tool call observed second. Decouples context extraction from divergence measurement. |
| **Ring buffer per brick** (max 30) | Bounded memory (~1.5MB worst case). Old observations age out naturally. |
| **Cooldown per brick** (default 60s) | Prevents signal spam for continuously-drifting tools. |
| **Fat signal with embedded evidence** | Self-contained — consumers don't need to query back. |
| **Conservative thresholds** | 5 obs, 0.7 divergence, 2 agents — reduces false positives at the cost of slower detection. |
| **Priority 460** | Between forge-demand (455) and feedback-loop (450). Close to forge-demand as a sibling forge-signal middleware. |
| **Standalone L0 types** | `ExaptationSignal` defined independently. Will unify with `BrickAnnotation` when #254 lands. |

---

## Layer Compliance

- [x] Imports only from `@koi/core` (L0) and L0u utilities (`@koi/errors`, `@koi/validation`)
- [x] No imports from `@koi/engine` (L1) or peer L2 packages
- [x] All interface properties are `readonly`
- [x] No `any`, no `enum`, no `class`, no `as Type` assertions in production code
- [x] ESM-only with `.js` extensions in all import paths
- [x] `check:layers` passes with zero violations
