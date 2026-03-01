# @koi/governance-memory — In-Memory Governance Backend

`@koi/governance-memory` is an L2 package that provides a concrete `GovernanceBackend`
implementation backed entirely by in-memory data structures. It features a Cedar-inspired
constraint DAG, adaptive thresholds, an anomaly bridge callback, and bounded ring-buffer
storage for compliance records and violations.

**Default-deny by design:** if no `permit` rule matches, the request is denied.

---

## Why it exists

`@koi/core` defines the `GovernanceBackend` contract (L0), and
`@koi/middleware-governance-backend` enforces it at the middleware layer (L2).
But neither provides an implementation — they are plugs without a socket.

```
Without governance-memory:

  GovernanceBackend interface ──▶ ???
  (nobody implements it)

With governance-memory:

  GovernanceBackend interface ──▶ createGovernanceMemoryBackend(config)
       │
       ├── PolicyEvaluator   → DAG-sorted rule evaluation
       ├── ConstraintChecker → delegates to DAG
       ├── ComplianceRecorder → ring buffer (bounded)
       ├── ViolationStore    → per-agent ring buffers (bounded)
       └── dispose()         → clears all state
```

This package solves four problems:

1. **Concrete backend** — a zero-dependency, in-memory `GovernanceBackend` that works out of the box
2. **Constraint DAG** — rules with `dependsOn` edges, topologically sorted, cycle-detected at construction
3. **Anomaly bridge** — optional callback to fetch anomaly signals (fail-open), enriching rule evaluation context
4. **Adaptive thresholds** — per-rule thresholds that tighten after violations and relax after clean evaluations

---

## Architecture

### Layer position

```
L0  @koi/core        ─ GovernanceBackend, PolicyEvaluator, ConstraintChecker,
                        ComplianceRecorder, ViolationStore, PolicyRequest,
                        GovernanceVerdict, Violation, GOVERNANCE_ALLOW (types + constants)
L0u @koi/errors      ─ KoiError, Result<T,E>, RETRYABLE_DEFAULTS
L0u @koi/validation  ─ validateNonEmpty (validators)
L2  @koi/governance-memory ─ this package (no L1 dependency)
```

### Internal module map

```
index.ts                      ← public re-exports
│
├── types.ts                  ← GovernanceRule, GovernanceMemoryConfig, EvaluationContext,
│                                AnomalySignalLike, AdaptiveThresholdConfig
├── dag.ts                    ← createConstraintDag() — Kahn's topological sort + cycle detection
├── evaluator.ts              ← createMemoryEvaluator() — DAG-aware rule evaluation
├── adaptive-threshold.ts     ← createAdaptiveThreshold() + adjustThreshold() (pure)
├── ring-buffer.ts            ← createRingBuffer<T>() — fixed-capacity circular buffer
├── store.ts                  ← createGovernanceMemoryStore() — compliance + violations + constraints
├── config.ts                 ← validateGovernanceMemoryConfig()
└── governance-memory.ts      ← createGovernanceMemoryBackend() — top-level factory
```

### Evaluation flow (single request)

```
createMemoryEvaluator(config)
       │
       ├─ build DAG at construction (sort once, freeze)
       │
evaluate(policyRequest)
       │
       ├─ fetch anomaly context (fail-open: try/catch getRecentAnomalies)
       │    └─ callback throws → anomalyCount = 0, continue
       │
       ├─ build EvaluationContext { anomalyCount, recentAnomalies, adaptiveThresholds }
       │
       ├─ iterate DAG-sorted rules:
       │    ├─ skip if rule scope doesn't match request kind
       │    ├─ skip if dependencies not yet satisfied
       │    ├─ evaluate rule.condition(request, context)
       │    │
       │    ├── effect: "forbid" + condition: true
       │    │    └─ return { ok: false, violations: [...] }  (short-circuit)
       │    │
       │    └── effect: "permit" + condition: true
       │         └─ mark as permitted, continue checking remaining forbids
       │
       ├─ no permit matched → default-deny { ok: false, violations: [...] }
       │
       └─ permitted → update adaptive thresholds (recovery)
            └─ return GOVERNANCE_ALLOW singleton
```

---

## The constraint DAG

Rules can declare `dependsOn: ["other-rule-id"]` to form a directed acyclic graph.
The DAG is built once at construction time using Kahn's algorithm:

```
┌────┐     ┌────┐     ┌────┐
│ r1 │────▶│ r2 │────▶│ r4 │
└────┘     └────┘     └────┘
  │                     ▲
  │        ┌────┐       │
  └───────▶│ r3 │───────┘
           └────┘

Topological order: r1, r2, r3, r4  (r2/r3 interchangeable)
```

### Validation at construction

| Check | Error |
|---|---|
| Duplicate rule IDs | `Duplicate rule id: "r1"` |
| Unknown `dependsOn` reference | `Rule "r2" depends on unknown rule "nonexistent"` |
| Cycle detected | `Cycle detected in constraint DAG` |

All validation errors throw immediately — a malformed DAG is a programming error,
not a runtime condition.

### Dependency satisfaction

During evaluation, a rule's dependencies must all have been evaluated as `permit`
for the rule to be considered. If any dependency was not satisfied (forbid or not evaluated),
the dependent rule is skipped.

---

## Adaptive thresholds

Rules can reference adaptive thresholds from the `EvaluationContext`.
Thresholds adjust automatically based on evaluation outcomes:

```
                    violation
currentValue ──────────────────▶ currentValue * decayRate
   (e.g., 100)                     (e.g., 90 if decayRate=0.9)

                    clean eval
currentValue ──────────────────▶ currentValue * recoveryRate
   (e.g., 90)                      (e.g., 91.8 if recoveryRate=1.02)

Clamped to: [floor, ceiling]
```

### Configuration

```typescript
interface AdaptiveThresholdConfig {
  readonly baseValue: number;       // starting value
  readonly decayRate: number;       // multiplier on violation (< 1.0 to tighten)
  readonly recoveryRate: number;    // multiplier on clean eval (> 1.0 to relax)
  readonly floor: number;           // minimum allowed value
  readonly ceiling: number;         // maximum allowed value
}
```

### Properties

- **Pure functions** — `createAdaptiveThreshold()` and `adjustThreshold()` return new objects
- **Immutable** — the original threshold is never mutated
- **Bounded** — values are clamped between `floor` and `ceiling`

---

## Anomaly bridge

The evaluator accepts an optional `getRecentAnomalies` callback that fetches anomaly
signals from an external source (e.g., `@koi/agent-monitor`). This avoids a direct
L2-to-L2 import — the callback is injected at wiring time.

```
┌────────────────────┐   getRecentAnomalies()   ┌──────────────────┐
│  governance-memory  │ ◀──────────────────────── │  (caller wires)  │
│  evaluator          │                           │  agent-monitor   │
│                     │   AnomalySignalLike[]     │  or any source   │
└────────────────────┘                           └──────────────────┘
```

### Fail-open semantics

If `getRecentAnomalies` throws, the evaluator catches the error and continues
with `anomalyCount = 0`. This prevents a broken monitor from blocking all governance
decisions.

### AnomalySignalLike

Minimal interface — avoids importing `@koi/agent-monitor` types:

```typescript
interface AnomalySignalLike {
  readonly kind: string;
  readonly sessionId: string;
}
```

---

## Bounded storage

### Ring buffer

Both compliance records and violations use fixed-capacity ring buffers:

```
capacity = 4

append(A) → [A]
append(B) → [A, B]
append(C) → [A, B, C]
append(D) → [A, B, C, D]   (full)
append(E) → [B, C, D, E]   (A evicted)
```

- **Compliance**: single ring buffer (default capacity: 10,000)
- **Violations**: per-agent ring buffers (default per-agent capacity: 1,000)

### ViolationStore queries

Violations can be filtered by:
- Agent ID
- Severity level
- Rule ID
- Time range (since/until)
- Pagination (offset + limit)

---

## API

### `createGovernanceMemoryBackend(config)`

```typescript
import { createGovernanceMemoryBackend } from "@koi/governance-memory";

const backend = createGovernanceMemoryBackend({
  rules: [
    {
      id: "deny-destructive-tools",
      effect: "forbid",
      priority: 0,
      scope: ["tool_call"],
      condition: (req) => {
        const toolId = (req.payload as Record<string, unknown>).toolId;
        return ["rm_rf", "drop_table"].includes(String(toolId));
      },
      message: "Destructive tools are forbidden",
    },
    {
      id: "allow-all",
      effect: "permit",
      priority: 10,
      condition: () => true,
      message: "Default allow",
    },
  ],
  complianceCapacity: 10_000,
  violationCapacity: 1_000,
});
```

Returns a full `GovernanceBackend` with all sub-interfaces wired.

### `GovernanceMemoryConfig`

```typescript
interface GovernanceMemoryConfig {
  readonly rules?: readonly GovernanceRule[];
  readonly complianceCapacity?: number;       // default: 10,000
  readonly violationCapacity?: number;        // default: 1,000
  readonly getRecentAnomalies?: () => readonly AnomalySignalLike[];
  readonly adaptiveThresholds?: ReadonlyMap<string, AdaptiveThresholdConfig>;
}
```

### `GovernanceRule`

```typescript
interface GovernanceRule {
  readonly id: string;
  readonly effect: "permit" | "forbid";
  readonly priority: number;                           // lower = evaluated first
  readonly scope?: readonly PolicyRequestKind[];       // filter by request kind
  readonly dependsOn?: readonly string[];              // DAG edges
  readonly condition: (request: PolicyRequest, context: EvaluationContext) => boolean;
  readonly message: string;
  readonly severity?: ViolationSeverity;               // default: "critical" for forbid
}
```

### `validateGovernanceMemoryConfig(config)`

```typescript
import { validateGovernanceMemoryConfig } from "@koi/governance-memory";

const result = validateGovernanceMemoryConfig(untrustedConfig);
if (!result.ok) {
  throw new Error(`Invalid config: ${result.error.message}`);
}
const backend = createGovernanceMemoryBackend(result.value);
```

---

## Examples

### 1. With anomaly bridge

```typescript
import { createGovernanceMemoryBackend } from "@koi/governance-memory";

const backend = createGovernanceMemoryBackend({
  rules: [
    {
      id: "deny-on-anomaly",
      effect: "forbid",
      priority: 0,
      condition: (_req, ctx) => ctx.anomalyCount > 0,
      message: "Denied due to active anomalies",
    },
    {
      id: "allow-all",
      effect: "permit",
      priority: 1,
      condition: () => true,
      message: "Allow",
    },
  ],
  getRecentAnomalies: () => monitorService.getRecentAnomalies(),
});
```

### 2. With constraint DAG

```typescript
const backend = createGovernanceMemoryBackend({
  rules: [
    {
      id: "check-quota",
      effect: "permit",
      priority: 0,
      condition: (req) => quotaService.hasQuota(req.agentId),
      message: "Quota check",
    },
    {
      id: "check-compliance",
      effect: "permit",
      priority: 1,
      dependsOn: ["check-quota"],  // only evaluated if quota check passes
      condition: (req) => complianceService.isCompliant(req),
      message: "Compliance check",
    },
    {
      id: "deny-non-compliant",
      effect: "forbid",
      priority: 2,
      dependsOn: ["check-compliance"],
      condition: (_req, _ctx) => true,  // catches anything that falls through
      message: "Non-compliant request denied",
    },
  ],
});
```

### 3. With governance middleware

```typescript
import { createGovernanceBackendMiddleware } from "@koi/middleware-governance-backend";
import { createGovernanceMemoryBackend } from "@koi/governance-memory";

const backend = createGovernanceMemoryBackend({ rules: myRules });
const middleware = createGovernanceBackendMiddleware({ backend });

// Pass to createKoi as middleware
```

---

## Performance properties

| Operation | Cost | Notes |
|---|---|---|
| DAG construction | O(V+E) once | Kahn's algorithm at factory time, result frozen |
| `evaluate()` per request | O(R) where R = rule count | Linear scan of sorted rules, short-circuit on first forbid |
| Anomaly bridge | 1 callback invocation | Fail-open: caught errors = zero overhead |
| Adaptive threshold update | O(T) where T = threshold count | Pure arithmetic per threshold |
| Compliance recording | O(1) amortized | Ring buffer append |
| Violation recording | O(1) amortized | Per-agent ring buffer append |
| Violation query | O(N) where N = agent violations | Linear scan with filters |
| `dispose()` | O(1) | Clears all internal state |

Memory is bounded: compliance records capped at `complianceCapacity`,
violations capped at `violationCapacity` per agent. No unbounded growth.

---

## Layer compliance

```
L0  @koi/core ─────────────────────────────────────────────┐
    GovernanceBackend, PolicyEvaluator, ConstraintChecker,  │
    ComplianceRecorder, ViolationStore, PolicyRequest,      │
    GovernanceVerdict, Violation, GOVERNANCE_ALLOW           │
                                                            │
L0u @koi/errors ────────────────────────────────────────────┤
    KoiError, Result<T,E>, RETRYABLE_DEFAULTS               │
                                                            │
L0u @koi/validation ────────────────────────────────────────┤
    validateNonEmpty                                         │
                                                            ▼
L2  @koi/governance-memory ◄────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
```

---

## Related

- Issue: #113
- L0 contract: `packages/core/src/governance-backend.ts`
- Middleware gate: `packages/middleware-governance-backend/`
- Anomaly source: `packages/agent-monitor/`
- Tests: `packages/governance-memory/src/*.test.ts`, `packages/governance-memory/src/__tests__/`
