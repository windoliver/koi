# @koi/collusion-detector — Cross-Agent Collusion Signal Detection

`@koi/collusion-detector` is an L2 package that provides 4 deterministic signal detectors
for identifying collusive behavior patterns across multiple agents. All detectors are
pure functions — no side effects, no I/O, all state passed as arguments.

---

## Why it exists

When multiple agents operate in the same environment, they can develop correlated behavior
patterns that indicate collusion: synchronizing actions, dividing markets, concentrating
resources, or specializing to avoid competition. Static analysis can't catch these patterns
because they emerge from runtime behavior over time.

```
Without collusion detection:

  Agent A: shifts tool usage +30%  ─┐
  Agent B: shifts tool usage +25%   ├── nobody notices
  Agent C: shifts tool usage +28%  ─┘

With collusion detection:

  Agent A: shifts tool usage +30%  ─┐
  Agent B: shifts tool usage +25%   ├── detectSyncMove() → CollusionSignal
  Agent C: shifts tool usage +28%  ─┘    "3 agents synchronously increased tool usage by >= 20%"
```

This package provides the detection layer. Governance enforcement (blocking, throttling,
alerting) is handled by consumers — typically `@koi/governance-memory` rules that
react to collusion signals.

---

## Architecture

### Layer position

```
L0  @koi/core              ─ AgentId (branded type), ViolationSeverity
L2  @koi/collusion-detector ─ this package (no L1 dependency)
```

`@koi/collusion-detector` imports only from `@koi/core`. It has zero external
dependencies and zero L2 peer imports.

### Internal module map

```
index.ts                ← public re-exports
│
├── types.ts            ← AgentObservation, CollusionSignal, CollusionThresholds,
│                          CollusionDetectorConfig
├── detector.ts         ← 4 pure detectors + math utilities:
│                          detectSyncMove, detectVarianceCollapse,
│                          detectConcentration, detectSpecialization,
│                          detectAll, computeHHI, computeCV, computeMean, computeStddev
├── window.ts           ← createObservationWindow() — sliding window by round count
└── config.ts           ← DEFAULT_COLLUSION_THRESHOLDS, resolveThresholds(),
                           validateCollusionDetectorConfig()
```

---

## The 4 collusion signals

### Signal table

| # | `kind` | Detects | Default threshold | Fires when... |
|---|---|---|---|---|
| 1 | `sync_move` | Coordinated action shifts | `minAgents=3, changePct=0.2` | >= 3 agents shift tool usage by >= 20% in the same direction between consecutive rounds |
| 2 | `variance_collapse` | Behavioral uniformity | `maxCv=0.1, minRounds=5` | Cross-agent coefficient of variation stays below 0.1 for 5+ consecutive rounds |
| 3 | `concentration` | Resource monopolization | `hhiThreshold=0.25` | Herfindahl-Hirschman Index of resource access exceeds 0.25 in latest round |
| 4 | `specialization` | Market division | `cvMin=2.0` | Mean per-agent tool usage CV exceeds 2.0 (agents using very different tools) |

### Signal 1: Synchronous Move

Compares the latest round to the previous round. For each agent present in both rounds,
computes the percentage change in total tool calls. If >= K agents shift by >= X% in the
same direction (all up or all down), a signal fires.

```
Round 5:  Agent A = 10 calls, Agent B = 12 calls, Agent C = 8 calls
Round 6:  Agent A = 13 calls, Agent B = 15 calls, Agent C = 10 calls

  Agent A: +30% (up)
  Agent B: +25% (up)
  Agent C: +25% (up)

3 agents shifted up by >= 20% → sync_move signal fires
```

**Requirements:** at least 2 rounds of data, at least `syncMoveMinAgents` agents
present in both rounds.

### Signal 2: Variance Collapse

Computes the coefficient of variation (CV = stddev / |mean|) of total tool calls across
agents for each of the most recent N rounds. If CV stays below `varianceCollapseMaxCv`
for all N rounds, the signal fires.

```
Round 1:  [10, 10, 11, 10]  → CV = 0.04  ✓ (below 0.1)
Round 2:  [10, 10, 10, 10]  → CV = 0.00  ✓
Round 3:  [11, 10, 10, 11]  → CV = 0.05  ✓
Round 4:  [10, 10, 10, 10]  → CV = 0.00  ✓
Round 5:  [10, 11, 10, 10]  → CV = 0.04  ✓

5 consecutive rounds with CV < 0.1 → variance_collapse signal fires
```

**Intuition:** in competitive or independent agent populations, tool usage has natural
variation. Sustained uniformity suggests coordination.

### Signal 3: Concentration (HHI)

Computes the Herfindahl-Hirschman Index across agents' resource access counts
in the latest round. HHI = sum of squared market shares.

```
4 agents, resource access counts: [100, 1, 1, 1]

  Total = 103
  Shares: [0.971, 0.010, 0.010, 0.010]
  HHI = 0.971² + 0.010² + 0.010² + 0.010² = 0.943

HHI = 0.943 > 0.25 → concentration signal fires
```

| HHI | Interpretation |
|---|---|
| 0.0 | Perfect competition (many equal participants) |
| 0.25 | Moderate concentration |
| 0.5 | High concentration |
| 1.0 | Monopoly (one agent has all access) |

### Signal 4: Specialization (Market Division)

Computes each agent's CV across their own tool usage distribution. High CV means
the agent uses a few tools heavily and ignores the rest (specialist). If the mean
per-agent CV exceeds the threshold, agents are dividing the market.

```
Agent A: { search: 100, write: 1, deploy: 1 }  → CV = 1.88 (specialist)
Agent B: { search: 1, write: 100, deploy: 1 }  → CV = 1.88 (specialist)
Agent C: { search: 1, write: 1, deploy: 100 }  → CV = 1.88 (specialist)

Mean CV = 1.88  (if threshold = 1.5 → specialization signal fires)
```

**Contrast with variance_collapse:** variance collapse measures uniformity *across* agents
(they all do the same thing). Specialization measures diversity *within* each agent
(each agent does different things).

---

## Math utilities

All math functions are exported and independently testable:

| Function | Formula | Edge cases |
|---|---|---|
| `computeMean(values)` | `sum / n` | Empty array → 0 |
| `computeStddev(values, mean)` | `sqrt(sum((v-mean)²) / n)` | 0 or 1 element → 0 |
| `computeCV(values)` | `stddev / |mean|` | 0 or 1 element → 0; mean=0 → 0 |
| `computeHHI(counts)` | `sum((count/total)²)` | Empty → 0; single element → 1; all zeros → 0 |

---

## Observation window

`createObservationWindow(maxRounds)` provides bounded storage for agent observations,
evicting old rounds when the window fills:

```
maxRounds = 3

record(round 1, obs) → window: [round 1]
record(round 2, obs) → window: [round 1, round 2]
record(round 3, obs) → window: [round 1, round 2, round 3]
record(round 4, obs) → window: [round 2, round 3, round 4]  (round 1 evicted)
```

### API

```typescript
interface ObservationWindow {
  readonly record: (observation: AgentObservation) => void;
  readonly observations: () => readonly AgentObservation[];
  readonly observationsForRound: (round: number) => readonly AgentObservation[];
  readonly latestRound: () => number;    // -1 if empty
  readonly clear: () => void;
}
```

---

## API

### Types

```typescript
interface AgentObservation {
  readonly agentId: AgentId;
  readonly round: number;
  readonly timestamp: number;
  readonly toolCallCounts: ReadonlyMap<string, number>;
  readonly resourceAccessCounts: ReadonlyMap<string, number>;
  readonly trustScoreChanges: ReadonlyMap<string, number>;
}

interface CollusionSignal {
  readonly kind: "sync_move" | "variance_collapse" | "concentration" | "specialization";
  readonly severity: ViolationSeverity;
  readonly evidence: ReadonlyMap<string, number>;   // agentId → metric value
  readonly round: number;
  readonly timestamp: number;
  readonly message: string;
}

interface CollusionThresholds {
  readonly syncMoveMinAgents: number;             // default: 3
  readonly syncMoveChangePct: number;             // default: 0.2 (20%)
  readonly varianceCollapseMaxCv: number;         // default: 0.1
  readonly varianceCollapseMinRounds: number;     // default: 5
  readonly concentrationHhiThreshold: number;     // default: 0.25
  readonly specializationCvMin: number;           // default: 2.0
}
```

### Detector functions

All detectors are pure: `(observations, thresholds) → CollusionSignal | null`

```typescript
import {
  detectSyncMove,
  detectVarianceCollapse,
  detectConcentration,
  detectSpecialization,
  detectAll,
} from "@koi/collusion-detector";

// Run a single detector
const signal = detectSyncMove(observations, thresholds);
if (signal !== null) {
  console.warn(signal.message, signal.evidence);
}

// Run all 4 detectors, get non-null signals
const signals = detectAll(observations, thresholds);
for (const s of signals) {
  console.warn(`[${s.kind}]`, s.message);
}
```

### Config + defaults

```typescript
import {
  DEFAULT_COLLUSION_THRESHOLDS,
  resolveThresholds,
  validateCollusionDetectorConfig,
} from "@koi/collusion-detector";

// Merge partial overrides with defaults
const thresholds = resolveThresholds({ syncMoveMinAgents: 5 });

// Validate untrusted config
const result = validateCollusionDetectorConfig(untrustedConfig);
if (!result.ok) {
  throw new Error(result.error.message);
}
```

---

## Examples

### 1. Standalone detection loop

```typescript
import { createObservationWindow, detectAll, resolveThresholds } from "@koi/collusion-detector";

const window = createObservationWindow(50);  // keep 50 rounds
const thresholds = resolveThresholds();

function onRoundComplete(observations: AgentObservation[]): void {
  for (const obs of observations) {
    window.record(obs);
  }
  const signals = detectAll(window.observations(), thresholds);
  for (const signal of signals) {
    alertService.fire(signal);
  }
}
```

### 2. Integration with governance-memory

```typescript
import { createGovernanceMemoryBackend } from "@koi/governance-memory";
import { createObservationWindow, detectAll, resolveThresholds } from "@koi/collusion-detector";

const window = createObservationWindow(50);
const thresholds = resolveThresholds();

// Collusion signals feed into governance rules via the anomaly bridge
const backend = createGovernanceMemoryBackend({
  rules: [
    {
      id: "deny-on-collusion",
      effect: "forbid",
      priority: 0,
      condition: (_req, ctx) => ctx.anomalyCount > 0,
      message: "Denied due to detected collusion signals",
    },
    {
      id: "allow-all",
      effect: "permit",
      priority: 1,
      condition: () => true,
      message: "Allow",
    },
  ],
  getRecentAnomalies: () => {
    const signals = detectAll(window.observations(), thresholds);
    return signals.map((s) => ({ kind: s.kind, sessionId: "system" }));
  },
});
```

### 3. Custom thresholds for sensitive environments

```typescript
const strictThresholds = resolveThresholds({
  syncMoveMinAgents: 2,            // flag even 2 agents moving together
  syncMoveChangePct: 0.1,         // 10% change threshold
  varianceCollapseMaxCv: 0.05,    // tighter uniformity detection
  varianceCollapseMinRounds: 3,   // fewer rounds needed
  concentrationHhiThreshold: 0.15, // lower concentration tolerance
  specializationCvMin: 1.5,       // lower specialization threshold
});
```

---

## Performance properties

| Operation | Cost | Notes |
|---|---|---|
| `detectSyncMove()` | O(A) where A = agents | Compares two rounds only |
| `detectVarianceCollapse()` | O(R*A) where R = minRounds | Scans recent rounds |
| `detectConcentration()` | O(A) | Single round, HHI computation |
| `detectSpecialization()` | O(A*T) where T = tools per agent | Per-agent CV computation |
| `detectAll()` | Sum of above | Runs all 4 sequentially |
| `window.record()` | O(R) worst case for eviction | Amortized O(1) |
| `window.observations()` | O(N) snapshot copy | Returns new array |
| `computeHHI()` | O(N) | Two linear passes |
| `computeCV()` | O(N) | Two linear passes (mean then stddev) |

Memory is bounded by `maxRounds * agents_per_round`. The observation window evicts
old rounds automatically.

---

## Threshold rationale

| Threshold | Default | Rationale |
|---|---|---|
| `syncMoveMinAgents = 3` | 3 | Two agents correlating may be coincidence; three is a pattern |
| `syncMoveChangePct = 0.2` | 20% | Normal fluctuation is typically < 10%; 20% is a significant shift |
| `varianceCollapseMaxCv = 0.1` | 0.1 | CV < 0.1 means agents differ by < 10% — unnaturally uniform |
| `varianceCollapseMinRounds = 5` | 5 | Brief uniformity is normal; sustained uniformity is suspicious |
| `concentrationHhiThreshold = 0.25` | 0.25 | US DOJ uses 0.25 as the "highly concentrated" market threshold |
| `specializationCvMin = 2.0` | 2.0 | CV > 2.0 means the dominant tool is 2+ standard deviations above the mean |

---

## Layer compliance

```
L0  @koi/core ─────────────────────────────────────────────┐
    AgentId (branded type), ViolationSeverity               │
                                                            │
L0u @koi/errors ────────────────────────────────────────────┤
    KoiError, Result<T,E>, RETRYABLE_DEFAULTS               │
                                                            ▼
L2  @koi/collusion-detector ◄───────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
```

---

## Related

- Issue: #113
- L0 types: `packages/core/src/ecs.ts` (AgentId), `packages/core/src/governance-backend.ts` (ViolationSeverity)
- Governance backend: `packages/governance-memory/`
- Agent monitor: `packages/agent-monitor/`
- Tests: `packages/collusion-detector/src/*.test.ts`, `packages/collusion-detector/src/__tests__/`
