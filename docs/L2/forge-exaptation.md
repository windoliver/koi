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
| `tokenize` | `ReadonlySet<string>` | Lowercased keyword set; drops stopwords + tokens shorter than 3 chars; splits snake_case / camelCase / acronym boundaries |
| `computeJaccardDistance` | `number ∈ [0,1]` | Set distance between two token sets |
| `detectDrift` | `DetectionResult` | Discriminated union: `drift` / `no-drift` / `invalid-config` |
| `suggestAction` | `ExaptationSuggestion` | Maps a result (+ stable-window count) to `none` \| `reclassify` \| `new-artifact` |

This package **does not** observe tool calls itself. Upstream observers (a future middleware in `@koi/forge-tools` or `@koi/crystallize`) feed `UsagePurposeObservation`s and consume the report.

---

## Detection

The detector first identifies the **divergent cohort** — agents whose own evidence clears the bar — then scores drift on that subset only. This prevents low-divergence baseline traffic from masking a smaller but consistent divergent cohort.

| Per-agent gate | Default | Why |
|---|---|---|
| Per-agent **divergent** observation count ≥ `minObservationsPerAgent` | 2 | Reject one-off spikes |
| Each cohort observation has `divergenceScore ≥ divergenceThreshold` | 0.7 | Baseline samples don't dilute the cohort — agents who *mix* baseline and drift still contribute their drift evidence |

| Cohort gate | Default | Why |
|---|---|---|
| `cohort.observationCount ≥ minObservations` | 5 | Enough cohort data to be meaningful — baseline traffic in the window doesn't count toward this |
| `cohort.avgDivergence ≥ divergenceThreshold` | 0.7 | Cohort drift is real |
| `cohort.divergentAgents ≥ minDivergentAgents` | 2 | Multiple independent agents |

`avgDivergence` and `observationCount` in the resulting `DriftReport` reflect the cohort, not the whole window.

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
| `result.kind ≠ "drift"` (no-drift, invalid-config, undefined) | `none` |
| `replayProtected: false` (any valid observation lacks `eventId`) | `none` |
| `(droppedCount + duplicateCount) / (validObservationCount + dropped + duplicate) > 25%` | `none` (low-quality window — the denominator is the *full* validated window, not just the divergent cohort, so clean baseline-heavy traffic isn't punished for the cohort being a small slice) |
| `stableWindows ≥ 2` AND `avgDivergence ≥ 0.85` | `new-artifact` — fork a specialized variant; the drift is a real second use case |
| Cohort share `< 50%` of validated window AND not stable+strong | `none` — minority drift should NOT overwrite the canonical purpose the baseline majority depends on; wait for it to grow into majority or qualify for `new-artifact` |
| Otherwise (cohort majority, single window or sub-fork divergence) | `reclassify` — rewrite the artifact's description to match observed usage |

`new-artifact` is gated on **raw `avgDivergence`**, not on saturated `severity`. With detection threshold `0.7` and fork threshold `0.85`, drift that barely clears detection cannot escalate to "fork" purely by accumulating more observations or agents over time.

The quality gate (default 25%) refuses to recommend irreversible action when most of the input window was discarded as malformed or as duplicates.

## Replay Protection

Replay protection is a **per-observation data contract**, not a config knob.

- The detector marks a window `replayProtected: true` only when **every valid observation** carries a non-empty string `eventId` — a stable upstream event identity such as a gateway correlation ID, an idempotency key, or a monotonic sequence number. That same `eventId` is used as the dedup key, scoped per-agent.
- If even one valid observation in the window lacks `eventId` (or has an empty string), the window is `replayProtected: false`, dedup does **not** run, and `suggestAction` refuses to recommend `reclassify` or `new-artifact`.
- There is no caller-supplied dedup key function and no honor-system "trust me, this is stable" boolean — both were rejected because the detector cannot validate them at runtime. Putting the contract on the data shape lets `isObservationValid` enforce it.
- `eventId` is optional in the L0 `UsagePurposeObservation` type, so upstream observers that only have best-effort telemetry can still feed the detector — they just can't unlock action-bearing suggestions until they propagate a stable event ID.

## suggestAction Contract

`suggestAction` accepts only `DetectionResult` instances **returned by this module's own `detectDrift`** — they carry an internal, non-exported brand symbol that the action API checks before applying its gates. Structurally-reconstructed objects (e.g. results round-tripped through JSON, or hand-built literals) are rejected as `none`. This means the quality and replay-protection gates cannot be bypassed by persisting a partial result and replaying a synthetic positive later: any cross-process handoff has to round-trip through `detectDrift` again.

## Dedup Conflict Resolution

When the same `(agentId, eventId)` arrives more than once with different payloads, the dedup picks the winner deterministically — highest `divergenceScore`, then highest `observedAt`, then lexicographic `contextText` — instead of first-write-wins. Reordering the same logical event set produces the same `DriftReport`.

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

// Observations must carry `eventId` (a stable upstream event identity) for
// suggestAction to recommend any action. Without it, detection still runs
// and you get telemetry, but suggestions return `none`.

// 1. Compute per-observation divergence upstream:
const description = tokenize(artifact.description);
const usage = tokenize(modelContextText);
const divergence = computeJaccardDistance(description, usage);

// 2. Push observations into a per-artifact buffer (bounded by the caller).
const observations = [/* { agentId, contextText, divergenceScore, observedAt } */];

// 3. Detect — branch on kind to distinguish detector failure from "no drift".
const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
switch (result.kind) {
  case "invalid-config": /* alert: thresholds rejected */; break;
  case "no-drift":       /* result.droppedCount > N → alert telemetry */; break;
  case "drift":          /* see step 4 */; break;
}

// 4. Decide. `stableWindows` is incremented by the caller across detection cycles.
const action = suggestAction(result, stableWindows);
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
