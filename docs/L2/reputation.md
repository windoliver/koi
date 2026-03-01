# @koi/reputation — In-Memory Reputation Backend

In-memory implementation of the `ReputationBackend` contract for recording agent interaction feedback and computing trust scores. Uses a weighted-average algorithm with per-agent ring-buffer storage. Sync operations, zero external dependencies — suitable for dev, test, and single-node deployments.

---

## Why It Exists

The L0 contract (`ReputationBackend` in `@koi/core`) defines the interface but has no implementations. Without a concrete backend, trust-aware routing, governance guards, and middleware feedback loops have nothing to write to or read from.

This package provides the simplest conforming backend:

```
Without @koi/reputation               With @koi/reputation
───────────────────────                ─────────────────────

No backend → contract is dead letter   In-memory backend → contract works
Routing has no trust signal            getScores() → filter candidates
Governance cannot check levels         getScore() → deny below threshold
Middleware cannot record feedback      record() → per-turn signal stored
```

---

## Architecture

`@koi/reputation` is an **L2 feature package** — depends on `@koi/core` (L0) only.

```
┌─────────────────────────────────────────────────────────────────────┐
│  @koi/core (L0) — reputation-backend.ts                             │
│                                                                     │
│  Types: ReputationBackend, ReputationFeedback, ReputationScore,    │
│         ReputationQuery, ReputationQueryResult                      │
│  Enums: ReputationLevel, FeedbackKind                              │
│  Constants: REPUTATION_LEVEL_ORDER, DEFAULT_REPUTATION_QUERY_LIMIT │
│  ECS token: REPUTATION: SubsystemToken<ReputationBackend>          │
├─────────────────────────────────────────────────────────────────────┤
│  @koi/reputation (L2)                                               │
│                                                                     │
│  ┌──────────────────────┐  ┌────────────────────────────────────┐  │
│  │ compute-score.ts     │  │ in-memory-backend.ts               │  │
│  │                      │  │                                    │  │
│  │ computeScore()       │  │ createInMemoryReputationBackend()  │  │
│  │ weighted average     │  │   → ReputationBackend              │  │
│  │ level thresholds     │  │                                    │  │
│  │ configurable weights │  │ Map<AgentId, feedback[]>           │  │
│  └──────────────────────┘  │ ring buffer (default 1000/agent)   │  │
│                             │ idempotent record                  │  │
│                             │ sync Result returns                │  │
│                             └────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────┐                                      │
│  │ component-provider.ts    │                                      │
│  │                          │                                      │
│  │ createReputationProvider │                                      │
│  │   (backend)              │                                      │
│  │   → ComponentProvider    │                                      │
│  │   REPUTATION token       │                                      │
│  └──────────────────────────┘                                      │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  Dependencies                                                       │
│  @koi/core (L0) only — zero L0u, zero external                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Score Algorithm

Weighted average of all feedback entries for an agent, mapped to a categorical level:

```
Input:  feedback[] for agent X
        weights: { positive: 1.0, neutral: 0.5, negative: 0.0 }

Score = sum(weight[entry.kind] for each entry) / count(entries)

Level thresholds:
  score >= 0.6  →  "high"
  score >= 0.4  →  "medium"
  score >= 0.2  →  "low"
  score <  0.2  →  "untrusted"
  no entries    →  undefined (callers treat as "unknown")

"verified" is never auto-assigned — requires external attestation.
```

Example:

```
Agent received: 8 positive, 1 neutral, 1 negative
Score = (8×1.0 + 1×0.5 + 1×0.0) / 10 = 0.85
Level = "high"
```

Weights are configurable at backend creation time.

---

## Quick Start

```typescript
import { createInMemoryReputationBackend, createReputationProvider } from "@koi/reputation";
import { agentId } from "@koi/core";

// 1. Create backend
const backend = createInMemoryReputationBackend();

// 2. Record feedback
await backend.record({
  sourceId: agentId("observer-agent"),
  targetId: agentId("worker-agent"),
  kind: "positive",
  timestamp: Date.now(),
});

// 3. Query score
const result = await backend.getScore(agentId("worker-agent"));
if (result.ok && result.value !== undefined) {
  console.log(result.value.level);  // "high"
  console.log(result.value.score);  // 1.0
}

// 4. Wire into agent assembly via ECS
const provider = createReputationProvider(backend);
// Pass provider to createKoi({ providers: [provider, ...] })
```

---

## Configuration

```typescript
interface InMemoryReputationConfig {
  /** Max feedback entries per agent (ring buffer cap). Default: 1000. */
  readonly maxEntriesPerAgent?: number | undefined;
  /** Custom weights per FeedbackKind. Default: positive=1.0, neutral=0.5, negative=0.0. */
  readonly weights?: Readonly<Record<FeedbackKind, number>> | undefined;
}
```

```typescript
// Custom configuration
const backend = createInMemoryReputationBackend({
  maxEntriesPerAgent: 500,
  weights: { positive: 1.0, neutral: 0.3, negative: 0.0 },
});
```

---

## API Reference

### Exports

| Export | Kind | Description |
|--------|------|-------------|
| `createInMemoryReputationBackend` | factory | Creates an in-memory `ReputationBackend` |
| `createReputationProvider` | factory | Creates a `ComponentProvider` that attaches backend on `REPUTATION` token |
| `computeScore` | pure function | `feedback[] → ReputationScore \| undefined` |
| `DEFAULT_FEEDBACK_WEIGHTS` | const | `{ positive: 1.0, neutral: 0.5, negative: 0.0 }` |
| `InMemoryReputationConfig` | type | Configuration for `createInMemoryReputationBackend` |

### Backend Methods (from L0 contract)

| Method | Required | Returns |
|--------|----------|---------|
| `record` | yes | `Result<void, KoiError>` — sync |
| `getScore` | yes | `Result<ReputationScore \| undefined, KoiError>` — sync |
| `getScores` | optional | `Result<ReadonlyMap<AgentId, Score \| undefined>, KoiError>` — sync |
| `query` | yes | `Result<ReputationQueryResult, KoiError>` — sync |
| `dispose` | optional | `void` — clears all data, marks backend as disposed |

All methods return synchronously (no async overhead) but callers must `await` per the L0 contract.

---

## Examples

### Trust-Aware Routing

```typescript
const candidates = [agentId("a"), agentId("b"), agentId("c")];
const result = await backend.getScores(candidates);

if (result.ok) {
  const eligible = candidates.filter((id) => {
    const score = result.value.get(id);
    // Fail-closed: undefined (unknown) is excluded
    return score !== undefined && score.level !== "untrusted" && score.level !== "unknown";
  });
  // Route to highest-scoring eligible agent
}
```

### Middleware Feedback Loop

```typescript
const feedbackMiddleware: KoiMiddleware = {
  name: "reputation-feedback",
  onAfterTurn: async (ctx) => {
    // Record positive signal for successful turns
    await backend.record({
      sourceId: agentId("system"),
      targetId: ctx.agent.pid.id,
      kind: ctx.output.stopReason === "error" ? "negative" : "positive",
      timestamp: Date.now(),
    });
  },
};
```

### Query Feedback History

```typescript
// Get recent negative feedback for an agent
const result = await backend.query({
  targetId: agentId("suspect-agent"),
  kinds: ["negative"],
  limit: 20,
});

if (result.ok) {
  for (const entry of result.value.entries) {
    console.log(`${entry.sourceId} reported negative at ${entry.timestamp}`);
  }
  if (result.value.hasMore) {
    // Paginate with before: entries[entries.length-1].timestamp
  }
}
```

---

## Performance

### Storage: O(k) per agent, O(n * k) total

Ring buffer caps entries at `maxEntriesPerAgent` (default 1000). Oldest entries are evicted when capacity is reached — no unbounded memory growth.

```
1000 agents × 1000 entries × ~100 bytes/entry ≈ 100 MB
Typical dev/test: 10-50 agents × 100-500 entries ≈ < 5 MB
```

### Operations

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `record` | O(n) | Dedup scan of agent's feedback bucket |
| `getScore` | O(n) | Weighted average over agent's entries |
| `getScores` | O(m * n) | m agents, n entries each |
| `query` | O(N) | Scans all entries across all agents, sorts result |

Where n = entries per agent, N = total entries across all agents, m = number of queried agents.

For production workloads with high throughput, use a dedicated backend (e.g., `@koi/reputation-nexus` with EigenTrust).

---

## Error Handling

| Scenario | Error Code | Retryable |
|----------|-----------|-----------|
| Backend disposed | `INTERNAL` | No |

All other operations succeed — there are no validation, permission, or rate-limit errors in the in-memory backend. The backend follows the fail-closed contract: `getScore()` returns `undefined` for unknown agents, which callers must treat as `"unknown"` trust level.

---

## Ring Buffer Behavior

```
maxEntriesPerAgent = 3

record(feedback_1)  →  [1]
record(feedback_2)  →  [1, 2]
record(feedback_3)  →  [1, 2, 3]      ← full
record(feedback_4)  →  [2, 3, 4]      ← feedback_1 evicted (FIFO)
record(feedback_4)  →  [2, 3, 4]      ← duplicate, no-op (idempotent)
```

Deduplication key: `(sourceId, targetId, kind, timestamp)` tuple.

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────────┐
    reputation-backend.ts — types + interfaces only        │
    ecs.ts — REPUTATION: SubsystemToken<ReputationBackend> │
                                                           │
L2  @koi/reputation ◄─────────────────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ never imports L0u packages
    ✓ @koi/core is the sole workspace dependency
```

---

## Testing

```bash
cd packages/reputation && bun test
```

36 tests across 3 files:

| File | Tests | Covers |
|------|-------|--------|
| `compute-score.test.ts` | 14 | Level thresholds, weighted average, custom weights, edge cases |
| `in-memory-backend.test.ts` | 17 | record/getScore, getScores batch, query filters, ring buffer, idempotency, dispose |
| `component-provider.test.ts` | 5 | Provider shape, REPUTATION key, stable reference, detach |
