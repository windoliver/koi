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

`suggestAction(observations, thresholds, priorWindows)` runs `detectDrift` on the current window AND on every prior window. Both inputs that gate `new-artifact` are observation-grounded — there is no caller-supplied integer counter and no caller-supplied `DetectionResult` value.

| Internal detection state | Suggestion |
|---|---|
| `kind ≠ "drift"` (no-drift, invalid-config) | `none` |
| `replayProtected: false` (any valid observation lacks `eventId`) | `none` |
| `(droppedCount + duplicateCount + conflictCount) / (validObservationCount + dropped + duplicate + conflict) > 25%` | `none` (low-quality window — denominator is the *full* validated window, so clean baseline-heavy traffic isn't punished for the cohort being a small slice; conflicts count as low-quality so a corrupted-replay attack cannot bias the window past the threshold) |
| `≥ STABLE_WINDOW_COUNT - 1` prior windows ALSO produced strong drift AND current `avgDivergence ≥ 0.85` | `new-artifact` — fork a specialized variant |
| Cohort share `< 50%` of validated window AND not stable+strong | `none` — minority drift should NOT overwrite the canonical purpose the baseline majority depends on |
| Otherwise (cohort majority, single window or sub-fork divergence) | `reclassify` — rewrite the artifact's description to match observed usage |

`new-artifact` is gated on **raw `avgDivergence`**, not on saturated `severity`. With detection threshold `0.7` and fork threshold `0.85`, drift that barely clears detection cannot escalate to "fork" purely by accumulating more observations or agents over time.

The quality gate (default 25%) refuses to recommend irreversible action when most of the input window was discarded as malformed or as duplicates.

## Replay Protection

Replay protection is a **per-observation data contract**, not a config knob.

- The detector marks a window `replayProtected: true` only when **every valid observation** carries a non-empty string `eventId` — a stable upstream event identity such as a gateway correlation ID, an idempotency key, or a monotonic sequence number. That same `eventId` is used as the dedup key, scoped to `(scope, agentId)`.
- If even one valid observation in the window lacks `eventId` (or has an empty string), the window is `replayProtected: false`, dedup does **not** run, and `suggestAction` refuses to recommend `reclassify` or `new-artifact`.
- There is no caller-supplied dedup key function and no honor-system "trust me, this is stable" boolean — both were rejected because the detector cannot validate them at runtime. Putting the contract on the data shape lets `isObservationValid` enforce it.
- `eventId` is optional in the L0 `UsagePurposeObservation` type, so upstream observers that only have best-effort telemetry can still feed the detector — they just can't unlock action-bearing suggestions until they propagate a stable event ID.

## suggestAction Contract

`suggestAction` takes raw observations (plus thresholds and `stableWindows`) and recomputes detection internally. There is **no** "trust this `DetectionResult`" path — that closes the trust boundary that earlier rounds left open: a buggy or untrusted caller cannot fabricate a `{ kind: "drift", replayProtected: true, ... }` literal and obtain `reclassify` / `new-artifact` without real observations behind it. Action recommendations are always grounded in detector-produced state.

`detectDrift` is still exported separately as the telemetry surface — call it when you want the full `DetectionResult` for logs, dashboards, or alerts. The two functions are independent: `suggestAction` does not consume `DetectionResult`, and the action verdict cannot be skewed by a stale or mutated result.

## Tenant Isolation

Tenant isolation is a runtime data contract, enforced by required fields — not by upstream documentation.

- Every observation carries `scope: string` (tenant / account / realm). It is **required**: `isObservationValid` drops observations with missing or whitespace-only `scope`, and there is no implicit "global" scope. That is the silent-merge failure mode the field exists to prevent.
- Replay dedup is keyed on `(scope, agentId, eventId)`. Two tenants that happen to mint the same `(agentId, eventId)` keep their evidence independent.
- Cohort attribution is keyed on `(scope, agentId)`. The same logical agent in two tenants counts as two cohort members — different tenants are different observers.
- Single-tenant deployments may use a constant scope (e.g. `"default"`); the field still has to be set, so every emitter has to make a deliberate choice rather than rely on `agentId` formatting conventions.

## eventId Contract

`eventId` is a **per-observation idempotency key**. The L0 docstring on `UsagePurposeObservation.eventId` is the authoritative spec; the short version:

- Derive deterministically from a stable per-call identity — e.g. `sha256(agentId + ":" + toolCallId)` where `toolCallId` is an upstream identifier of the originating tool invocation. NOT a request-level correlation ID, NOT an upstream causal event ID shared across agents, NOT an account/tenant identifier, NOT a freshly-minted nonce/UUID (random values mint a new key per retry and defeat replay dedup).
- Retries of the same observation MUST re-emit the same `eventId` — that is what idempotent derivation buys you.
- Distinct tool calls within one request, multiple agents recording the same upstream event, and observations from different tenants must all derive **different** `eventId`s.
- Cross-tenant `(agentId, eventId)` collisions are absorbed by `scope` (see Tenant Isolation), so a tenant whose telemetry happens to overlap with a peer's identifiers still keeps independent evidence.

## Dedup Conflict Quarantine

Dedup is keyed on `(scope, agentId, eventId)`. The contract above guarantees per-observation `eventId` uniqueness within a `(scope, agentId)`, so the bucket is what catches retries; cross-tenant `(agentId, eventId)` collisions stay in distinct buckets via `scope`.

When the same `(scope, agentId, eventId)` arrives more than once with **non-identical** payloads (`divergenceScore` or `contextText` mismatch), the entire bucket is **quarantined** — every observation that touched it is counted in `conflictCount` and dropped from cohort scoring. Earlier rounds picked max-divergence as a "deterministic" winner, but that systematically biases the system toward the most alarming sample: one corrupted replay could push a benign observation into drift territory and unlock irreversible action recommendations. Quarantine is the safe-by-default response, and `suggestAction`'s quality gate folds `conflictCount` into its low-quality denominator so a high-conflict window cannot drive `reclassify` / `new-artifact`.

Identical-payload retries (same `divergenceScore` AND same `contextText`) still collapse normally as duplicates — those are the safe replays that replay protection is designed to handle.

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
//    Every observation must carry { scope, agentId, divergenceScore, contextText, observedAt }
//    and SHOULD carry eventId to unlock action-bearing suggestions.
const observations = [/* UsagePurposeObservation */];

// 3. Detect — branch on kind to distinguish detector failure from "no drift".
//    Use this surface for telemetry / dashboards / alerts.
const result = detectDrift(observations, DEFAULT_EXAPTATION_THRESHOLDS);
switch (result.kind) {
  case "invalid-config": /* alert: thresholds rejected */; break;
  case "no-drift":       /* result.droppedCount > N → alert telemetry */; break;
  case "drift":          /* result is observability state */; break;
}

// 4. Decide. suggestAction recomputes detection on the current window AND on
//    every priorWindow internally. The caller maintains a sliding history of
//    recent observation windows; suggestAction derives stability from that
//    history instead of trusting a caller-supplied integer counter.
const priorWindows = recentWindows; // readonly UsagePurposeObservation[][]
const action = suggestAction(observations, DEFAULT_EXAPTATION_THRESHOLDS, priorWindows);
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
