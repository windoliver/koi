# ReputationBackend — Pluggable Trust Scoring Contract (L0)

A canonical L0 interface for recording agent interaction feedback, querying computed trust scores, and filtering feedback history. Backend implementations are swappable — in-memory for dev/test, EigenTrust or Nexus for production — with zero changes to consumers.

---

## Why It Exists

Koi agents delegate to other agents and tools constantly. Without trust data, routing is blind:

```
Without ReputationBackend          With ReputationBackend
─────────────────────────          ──────────────────────

Router picks by latency only       Router checks score first
Unknown agent? Routed anyway       Unknown agent? Fail-closed → skip
Bad actor? No signal               Consistent negatives → untrusted → blocked
All agents look the same           Level order: unknown < low < medium < high < verified
```

Three systems consume reputation data once it exists:

| Consumer | What it does with scores |
|----------|--------------------------|
| **Trust-aware routing** | `getScores(ids[])` batch-checks candidates before picking one |
| **Governance controller** | Blocks high-stakes tool calls from agents below a level threshold |
| **Middleware feedback loop** | `onAfterTurn` records positive/negative signal after every turn |

---

## Layer Position

```
L0  @koi/core
    └── ReputationBackend          ← interface only (this doc)
        ReputationFeedback         ← input shape
        ReputationScore            ← output shape
        ReputationQuery            ← filter shape
        ReputationLevel            ← "unknown" | "untrusted" | "low" | "medium" | "high" | "verified"
        FeedbackKind               ← "positive" | "negative" | "neutral"
        REPUTATION_LEVEL_ORDER     ← frozen ordered array
        DEFAULT_REPUTATION_QUERY_LIMIT  ← 100

L2  @koi/reputation-memory (future)
    └── implements ReputationBackend
    └── in-memory ring buffer, sync, dev/test

L2  @koi/reputation-nexus (future)
    └── implements ReputationBackend
    └── EigenTrust algorithm, async, production
```

`@koi/core` has zero dependencies. `ReputationBackend` imports only from `./common.js`, `./ecs.js`, and `./errors.js` — no vendor types, no framework concepts.

---

## Architecture

### The contract surface

```
ReputationBackend
│
├── record(feedback)          required — store one trust signal
├── getScore(targetId)        required — score for one agent, undefined if unknown
├── getScores?(targetIds[])   optional — batch score for N agents (N+1-safe)
├── query(filter)             required — paginated feedback history
└── dispose?()                optional — release resources
```

All methods return `T | Promise<T>` — in-memory implementations are sync, network/database implementations are async. Callers always `await`.

### Fail-closed contract

`getScore()` returns `undefined` when no feedback exists for an agent. Callers **must** treat `undefined` as `"unknown"` trust level — never as implicit trust:

```
getScore(newAgent) → undefined   ← no data
                                  ← caller must deny, not allow
```

This is intentional: a new agent with no history is not trusted by default.

### Feedback input vs score output

```
Feedback input (what you provide):        Score output (what backends compute):

ReputationFeedback {                      ReputationScore {
  sourceId: AgentId   ← observer            agentId: AgentId
  targetId: AgentId   ← subject             score: number     ← [0, 1] continuous
  kind: FeedbackKind  ← semantic signal      level: ReputationLevel ← categorical
  context?: JsonObject                       feedbackCount: number
  timestamp: number                          computedAt: number
}                                         }

No numeric score on input.
Backends derive weights from kind
using their own algorithm.
```

No score field on input avoids the ambiguity of `kind: "positive"` with `score: -0.5`. `kind` is the authoritative signal.

---

## Data Flow

### Turn feedback loop (middleware path)

```
  User input
      │
      ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  L1 Engine middleware chain                                   │
  │                                                              │
  │  onBeforeTurn()  ──► model call ──► tool calls ──►           │
  │                                                              │
  │  onAfterTurn(ctx: TurnContext)                               │
  │    ctx.session.agentId  ← plain string from session context  │
  │    agentId(ctx.session.agentId) ← cast to branded AgentId   │
  │    backend.record({                                          │
  │      sourceId: observer,                                     │
  │      targetId: agentId(ctx.session.agentId),                │
  │      kind: "positive",                                       │
  │      context: { turnIndex: ctx.turnIndex },                  │
  │      timestamp: Date.now(),                                  │
  │    })                                                        │
  └──────────────────────────────────────────────────────────────┘
      │
      ▼
  ReputationBackend.record() ──► stored signal
```

### Trust-aware routing (batch path)

```
  Router selects candidate agents:

  candidates = [agentA, agentB, agentC, agentD]
      │
      ▼
  backend.getScores(candidates)
      │
      ▼
  Map {
    agentA → { level: "high",      score: 0.91 }
    agentB → { level: "untrusted", score: 0.08 }
    agentC → undefined                            ← unknown = fail-closed
    agentD → { level: "medium",    score: 0.61 }
  }
      │
      ▼
  Filter: keep level ≥ "medium"
  (REPUTATION_LEVEL_ORDER.indexOf(level) ≥ REPUTATION_LEVEL_ORDER.indexOf("medium"))
      │
      ▼
  Eligible: [agentA (high), agentD (medium)]
  Skipped:  agentB (untrusted), agentC (unknown — fail-closed)
      │
      ▼
  Route to agentA (highest score)
```

One `getScores()` call replaces N individual `getScore()` calls — no N+1 problem.

### Governance guard (per-call check)

```
  Agent proposes high-stakes tool call:
      │
      ▼
  GovernanceController.check()
      │
      ├── backend.getScore(agentId)
      │       │
      │       ├── undefined  ──► deny (fail-closed, unknown agent)
      │       │
      │       └── { level: "low" }
      │               │
      │               └── REPUTATION_LEVEL_ORDER.indexOf("low")
      │                     < REPUTATION_LEVEL_ORDER.indexOf("medium")
      │                   ──► deny (below threshold)
      │
      └── { level: "high" }  ──► allow
```

---

## ReputationLevel

Six discrete levels, ordered least-to-most trusted:

```
REPUTATION_LEVEL_ORDER = [
  "unknown",    ← no feedback data — fail-closed (deny by default)
  "untrusted",  ← consistent negative signals
  "low",        ← sparse or mixed signals
  "medium",     ← moderate positive history
  "high",       ← strong consistent positives
  "verified",   ← externally attested or governance-promoted
]
```

Use the array for comparisons — never hardcode the ordering:

```typescript
// Safe: uses the canonical order
const idx = REPUTATION_LEVEL_ORDER.indexOf(score.level);
if (idx >= REPUTATION_LEVEL_ORDER.indexOf("medium")) {
  // allow
}

// Unsafe: brittle if levels are added or reordered
if (score.level === "high" || score.level === "verified") { ... }
```

`"verified"` is not emitted by scoring algorithms — it requires external attestation (governance promotion, cryptographic proof, etc.).

---

## Query and Pagination

`query(filter)` returns raw feedback entries for audit, debugging, and domain-scoped analytics:

```
ReputationQuery (all fields optional):
  targetId?  ← filter by subject agent
  sourceId?  ← filter by observer agent
  kinds?     ← ["positive", "negative", "neutral"] subset
  after?     ← Unix ms lower bound (inclusive)
  before?    ← Unix ms upper bound (exclusive)
  limit?     ← max entries (default: DEFAULT_REPUTATION_QUERY_LIMIT = 100)

ReputationQueryResult:
  entries    ← readonly ReputationFeedback[], ordered by timestamp desc
  hasMore    ← true if results were truncated — paginate with before/after
```

Empty filter returns all entries up to `limit` — use with care on large datasets.

---

## Comparison: OpenClaw / NanoClaw vs Koi

| Dimension | NanoClaw | OpenClaw (ClawHub) | Koi ReputationBackend |
|-----------|----------|--------------------|-----------------------|
| Scope | Infrastructure (containers) | Skills / plugins | **Agents at runtime** |
| Pluggable backend | No | No (Convex hardcoded) | **Yes — L0 contract** |
| Score type | Binary (trusted group / not) | Stars, downloads, badges | **Continuous [0,1] + level** |
| Fail-closed | No | No | **Yes — undefined = deny** |
| Batch scoring | No | No | **Yes — getScores(ids[])** |
| Wires into routing | No | No | **Yes** |
| Wires into governance | No | No | **Yes** |
| Feedback loop | No | Crowd reports (manual) | **Yes — per-turn middleware** |

---

## API Reference

### Types

| Export | Kind | Description |
|--------|------|-------------|
| `ReputationBackend` | interface | The main contract — implement this |
| `ReputationFeedback` | interface | Input to `record()` |
| `ReputationScore` | interface | Output from `getScore()` / `getScores()` |
| `ReputationQuery` | interface | Filter for `query()` |
| `ReputationQueryResult` | interface | Output from `query()` |
| `ReputationLevel` | type | `"unknown" \| "untrusted" \| "low" \| "medium" \| "high" \| "verified"` |
| `FeedbackKind` | type | `"positive" \| "negative" \| "neutral"` |

### Runtime values

| Export | Type | Value |
|--------|------|-------|
| `REPUTATION_LEVEL_ORDER` | `readonly ReputationLevel[]` | Frozen ordered array of all 6 levels |
| `DEFAULT_REPUTATION_QUERY_LIMIT` | `number` | `100` |

### ReputationBackend methods

| Method | Required | Signature |
|--------|----------|-----------|
| `record` | yes | `(feedback) → Result<void, KoiError> \| Promise<...>` |
| `getScore` | yes | `(targetId) → Result<ReputationScore \| undefined, KoiError> \| Promise<...>` |
| `getScores` | no | `(targetIds[]) → Result<ReadonlyMap<AgentId, ReputationScore \| undefined>, KoiError> \| Promise<...>` |
| `query` | yes | `(filter) → Result<ReputationQueryResult, KoiError> \| Promise<...>` |
| `dispose` | no | `() → void \| Promise<void>` |

---

## Implementing a Backend

Minimal conforming implementation (synchronous, in-memory):

```typescript
import type { ReputationBackend, ReputationFeedback, ReputationQuery } from "@koi/core";
import { DEFAULT_REPUTATION_QUERY_LIMIT } from "@koi/core";

const backend: ReputationBackend = {
  record: (feedback) => {
    // store feedback
    return { ok: true, value: undefined };
  },

  getScore: (targetId) => {
    // compute score from stored feedback
    // return undefined if no feedback for this agent
    return { ok: true, value: undefined };
  },

  query: (filter) => {
    const limit = filter.limit ?? DEFAULT_REPUTATION_QUERY_LIMIT;
    // filter stored feedback, sort descending, paginate
    return { ok: true, value: { entries: [], hasMore: false } };
  },
};
```

Key implementation rules:

1. **`getScore` returns `undefined` for agents with no feedback** — never fabricate a score
2. **`record` should be idempotent** for identical `(sourceId, targetId, kind, timestamp)` tuples — handles retries
3. **`query` returns entries ordered by `timestamp` descending** — most recent first
4. **All fallible operations return `Result<T, KoiError>`** — never throw for expected failures

---

## Future Backend Implementations

```
@koi/core (L0)
└── ReputationBackend ← this contract

@koi/reputation-memory (L2, planned)
└── in-memory ring buffer
└── FIFO eviction (configurable cap)
└── simple weighted average scoring
└── sync — zero async overhead
└── use for: dev, test, single-node

@koi/reputation-nexus (L2, planned)
└── EigenTrust global eigenvector
└── Sybil resistance via stake weighting
└── Ring detection (feedback manipulation defence)
└── async — HTTP to Nexus service
└── use for: production, multi-node
```

Consumers (routing, governance, middleware) code against `ReputationBackend` — switching from `@koi/reputation-memory` to `@koi/reputation-nexus` is a one-line change at the composition root.

---

## Testing

### Core contract tests (no LLM)

```bash
bun test packages/core/src/reputation-backend.test.ts
```

Covers: `ReputationFeedback` shape, `REPUTATION_LEVEL_ORDER` ordering and immutability, `ReputationLevel` values, `ReputationScore` shape, `ReputationQuery` filter shapes, `ReputationQueryResult` pagination shape, `ReputationBackend` interface structural conformance.

### Export inventory

```bash
bun test packages/core/src/__tests__/exports.test.ts
```

Compile-time regression guard — fails if any exported type or value is accidentally removed.

### E2E tests (real Anthropic API)

```bash
bun test --env-file .env tests/e2e/reputation-backend-e2e.test.ts
```

21 tests total: 16 contract tests (always run) + 5 real LLM tests (gated on `ANTHROPIC_API_KEY`).

| Section | Tests | What it proves |
|---------|-------|----------------|
| Contract | 16 | All interface methods, fail-closed contract, level ordering, pagination, dispose cleanup |
| `createLoopAdapter` E2E | 3 | `onAfterTurn` feedback loop, `runtime.agent.pid.id` as target, batch `getScores` for routing |
| `createPiAdapter` E2E | 2 | `wrapModelStream` intercept + feedback, Pi streaming + level verification |
