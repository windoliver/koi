# @koi/forge-exaptation — Purpose-Drift Detection

`@koi/forge-exaptation` is an L2 package that detects when forge artifacts (tools, skills, agents) are used for purposes beyond their original demand. It is a **pure-function library** — no middleware, no state, no I/O — that takes usage observations as input and returns a drift report plus a recommended action.

Issue: [#1351](https://github.com/windoliver/koi/issues/1351).

---

## Why It Exists

Bricks are forged against a stated demand, but real-world usage drifts. A "file-reader" forged to parse configs ends up parsing logs, CSVs, and YAML manifests across many agents. The interface fossilizes while the actual usage spreads — and nobody notices because the tool keeps working.

**Exaptation** (biology) — a trait that evolved for one purpose and got co-opted for another (feathers → flight). Detecting it in bricks reveals where the system is organically adapting.

---

## Scope

This package provides:

| Function | Returns | Role |
|---|---|---|
| `tokenize` | `ReadonlySet<string>` | Lowercased keyword set; drops stopwords + tokens shorter than 3 chars |
| `computeJaccardDistance` | `number ∈ [0,1]` | Set distance between two token sets |
| `detectDrift` | `DriftReport \| undefined` | Three-criteria detector over a window of observations |
| `suggestAction` | `ExaptationSuggestion` | Maps a report (+ stable-window count) to `none` \| `reclassify` \| `new-artifact` |

This package **does not** observe tool calls itself. Upstream observers (a future middleware in `@koi/forge-tools` or `@koi/crystallize`) feed `UsagePurposeObservation`s and consume the report.

---

## Detection

`detectDrift` requires all three criteria:

| Criterion | Default | Why |
|---|---|---|
| `observations.length ≥ minObservations` | 5 | Enough data to be meaningful |
| `avgDivergence ≥ divergenceThreshold` | 0.7 | Average usage substantially different from stated purpose |
| `divergentAgents ≥ minDivergentAgents` | 2 | Multiple independent agents — not just one outlier |

Conservative thresholds favour low false-positive rate over fast detection.

### Severity

```
severity = clamp(avgDivergence × agentMultiplier × observationMultiplier × confidenceWeight, 0, 1)
agentMultiplier       = min(divergentAgents / minDivergentAgents, 2)
observationMultiplier = min(observationCount / minObservations,   2)
confidenceWeight      = 0.8 (default)
```

Severity ∈ [0, 1]: scales with how broadly and how strongly the artifact has drifted.

---

## Suggestion Policy

| Inputs | Suggestion |
|---|---|
| `report = undefined` | `none` |
| Single drift window (`stableWindows < 2`) | `reclassify` — rewrite the artifact's description to match observed usage |
| `stableWindows ≥ 2` AND `severity ≥ 0.8` | `new-artifact` — fork a specialized variant; the drift is a real second use case |

The two-window stability gate prevents a single noisy window from triggering speculative artifact creation.

---

## API

```typescript
import {
  detectDrift,
  suggestAction,
  DEFAULT_EXAPTATION_THRESHOLDS,
  type DriftReport,
  type ExaptationSuggestion,
  type ExaptationThresholds,
  tokenize,
  computeJaccardDistance,
} from "@koi/forge-exaptation";

// 1. Compute per-observation divergence upstream:
const description = tokenize(artifact.description);
const usage = tokenize(modelContextText);
const divergence = computeJaccardDistance(description, usage);

// 2. Push observations into a per-artifact buffer (bounded by the caller).
const observations = [/* { agentId, contextText, divergenceScore, observedAt } */];

// 3. Detect.
const report = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);

// 4. Decide. `stableWindows` is incremented by the caller across detection cycles.
const action = suggestAction(report, stableWindows);
switch (action.kind) {
  case "none":         break;
  case "reclassify":   /* update artifact description */ break;
  case "new-artifact": /* fork a specialized variant */ break;
}
```

---

## Layer Compliance

- L2 — depends on `@koi/core` (L0) + `@koi/forge-types` (L0u) only.
- No `@koi/engine` (L1) or peer L2 imports.
- All interface properties are `readonly`. No `any` / `enum` / `class` / `as Type`.
- ESM-only with `.js` import paths.
- Marked `koi.optional: true` — exempt from `check:orphans` until wired into a forge pipeline.

## What This Package Is Not

- **Not a middleware.** Observation collection lives upstream.
- **Not semantic.** Jaccard is lexical; synonyms count as different. Sufficient for obvious drift; the divergence function can be swapped for embedding cosine without changing the detector contract.
- **Not stateful.** No ring buffers, no cooldowns. Callers manage observation windows and stable-window counts.
