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
| `(droppedCount + duplicateCount + conflictCount + missingEventIdCount) / (validObservationCount + dropped + duplicate + conflict) > 25%` | `none` (low-quality window — `missingEventIdCount` folds partial telemetry outage into the gate even when those samples sit outside the cohort, so cohort-scoped replay protection cannot hide a wide outage; conflicts count too, blocking corrupted-replay attacks that try to bias the window past the threshold) |
| ≥ `STABLE_WINDOW_COUNT - 1` *trailing consecutive* prior windows (recency derived from each window's max `observedAt` — caller-supplied array order is ignored, so a buggy/malicious caller cannot reorder old strong drift into the trailing slot) are strong-drift AND ALSO pass the action quality gate (`drift`, `replayProtected`, `avgDivergence ≥ 0.85`, `≤ 25%` low-quality), AND current `avgDivergence ≥ 0.85` | `new-artifact` — fork a specialized variant |
| Cohort share `< 50%` of validated window AND not stable+strong | `none` — minority drift should NOT overwrite the canonical purpose the baseline majority depends on |
| Otherwise (cohort majority, single window or sub-fork divergence) | `reclassify` — rewrite the artifact's description to match observed usage |

`new-artifact` is gated on **raw `avgDivergence`**, not on saturated `severity`. With detection threshold `0.7` and fork threshold `0.85`, drift that barely clears detection cannot escalate to "fork" purely by accumulating more observations or agents over time.

The quality gate (default 25%) refuses to recommend irreversible action when most of the input window was discarded as malformed or as duplicates.

## Replay Protection

Replay protection is a **per-observation data contract**, not a config knob.

- The detector marks a `drift` result `replayProtected: true` when **every observation contributing to the divergent cohort** carries a non-empty string `eventId`. Replay protection is **cohort-scoped**, not window-scoped: a baseline sample missing `eventId` outside the cohort does NOT veto action for an otherwise replay-protected cohort. Earlier rounds gated on the whole window, which created an easy denial path — one bad emitter could keep the detector permanently non-actionable.
- If a cohort observation lacks `eventId` (so dedup couldn't run on evidence the action depends on), `replayProtected: false`, and `suggestAction` refuses to recommend `reclassify` or `new-artifact`.
- Dedup itself always runs on the eventId-bearing subset, regardless of the action gate; observations without `eventId` pass through unchanged so partial telemetry failure doesn't lose data.
- There is no caller-supplied dedup key function and no honor-system "trust me, this is stable" boolean — both were rejected because the detector cannot validate them at runtime. Putting the contract on the data shape lets `isObservationValid` enforce it.
- `eventId` is optional in the L0 `UsagePurposeObservation` type, so upstream observers that only have best-effort telemetry can still feed the detector — they just can't unlock action-bearing suggestions for a cohort whose evidence isn't fully replay-protected.

## suggestAction Contract

`suggestAction` takes raw observations (plus thresholds and `stableWindows`) and recomputes detection internally. There is **no** "trust this `DetectionResult`" path — that closes the trust boundary that earlier rounds left open: a buggy or untrusted caller cannot fabricate a `{ kind: "drift", replayProtected: true, ... }` literal and obtain `reclassify` / `new-artifact` without real observations behind it. Action recommendations are always grounded in detector-produced state.

`detectDrift` is still exported separately as the telemetry surface — call it when you want the full `DetectionResult` for logs, dashboards, or alerts. The two functions are independent: `suggestAction` does not consume `DetectionResult`, and the action verdict cannot be skewed by a stale or mutated result.

## Tenant Isolation

Tenant isolation is a runtime data contract, enforced by required fields — not by upstream documentation.

- Every observation carries `scope?: string` (tenant / account / realm). It is **optional only for backward compatibility**: missing or whitespace-only values normalize to a single explicit `__legacy__` sentinel inside the detector, so pre-multi-tenant emitters keep wire-compat (the silent-drop failure mode is avoided) without silently merging into an unnamed "global" namespace (the silent-merge failure mode is also avoided — the sentinel is itself a scope, observable in cohort keys, alertable, and grep-able).
- Replay dedup is keyed on `(scope, agentId, eventId)`. Two tenants that happen to mint the same `(agentId, eventId)` keep their evidence independent.
- Cohort attribution is keyed on `(scope, agentId)`. The same logical agent in two tenants counts as two cohort members — different tenants are different observers.
- **New emitters MUST set `scope`** explicitly. Single-tenant deployments may use a constant value (e.g. `"default"`); multi-tenant deployments MUST derive it from authenticated identity at the boundary. Any deployment that lets multi-tenant traffic fall into `__legacy__` will mix tenants in that bucket — the sentinel is a migration aid, not a default tenant.
- Emitters can be migrated incrementally: ship the new `scope`-aware producer alongside legacy producers; observe `__legacy__` in dashboards/alerts; swap producers tenant-by-tenant; deprecate `__legacy__` once it is empty.
- **Action-bearing safety during migration:** when any cohort observation is in `__legacy__`, `detectDrift` sets `cohortHasLegacyScope: true` on the result and `suggestAction` refuses to emit `reclassify` / `new-artifact`. The drift signal is still surfaced for dashboards/telemetry, but irreversible actions stay blocked until producers are migrated to explicit scope. Legacy-contaminated prior windows likewise do not count toward stability.

## Artifact Identity

The detector is per-artifact: drift in one artifact (tool / skill / agent) is independent of drift in another. `UsagePurposeObservation.artifactId` is **required** at the L0 contract, and `suggestAction` rejects any prior whose `artifactId` does not appear in the current window's artifact set. Combined with the per-observation overlap check, this ensures:

- A routing bug or multi-artifact buffer mixup that hands a strong prior from a different artifact to `suggestAction` cannot unlock `new-artifact` for the current artifact.
- A timestamp-skewed clone of the current window cannot pose as a "prior" — `windowSignature` excludes `observedAt` and the prior-overlap check rejects any prior that shares even one validated observation identity with the current window.

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
//    history instead of trusting a caller-supplied integer counter. Recency
//    inside priorWindows is derived from each window's max `observedAt` —
//    callers may supply windows in any array order without affecting the
//    verdict.
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
