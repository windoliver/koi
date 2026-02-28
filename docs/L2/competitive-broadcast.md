# @koi/competitive-broadcast — GWT-Inspired Competitive Selection + Broadcast

Implements Global Workspace Theory (Baars)-inspired agent coordination: multiple agents compete to solve the same task, the best result is selected via a pluggable strategy, and the winner is broadcast to all agents for system-wide coherence. Composes with `@koi/parallel-minions` for the spawn/collection phase.

---

## Why It Exists

Koi has fan-out (`@koi/parallel-minions`) and DAG orchestration (`@koi/orchestrator`), but neither provides a **competitive selection + broadcast** pattern. Without this package, when multiple agents solve the same task:

- The user sees N conflicting answers and must pick manually
- No automatic quality selection — fastest, best-scored, or consensus
- No coherence mechanism — other agents don't know which answer "won"
- No broadcast — the winning result isn't shared back for alignment

`@koi/competitive-broadcast` closes this gap with a single `runCycle()` call that selects a winner and broadcasts it.

---

## Architecture

`@koi/competitive-broadcast` is an **L2 feature package** — it depends only on L0 (`@koi/core`). Zero external dependencies.

```
┌──────────────────────────────────────────────────────────────┐
│  @koi/competitive-broadcast  (L2)                            │
│                                                              │
│  types.ts       ← Proposal, ProposalId, SelectionStrategy,  │
│                    BroadcastSink, CycleEvent, Vote           │
│  selection.ts   ← 3 built-in selection strategy factories    │
│  broadcast.ts   ← 2 built-in broadcast sink factories        │
│  cycle.ts       ← runCycle() core pipeline                   │
│  config.ts      ← CycleConfig validation + defaults          │
│  index.ts       ← public API surface                         │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Dependencies                                                │
│                                                              │
│  @koi/core  (L0)   KoiError, Result, AgentId,               │
│                     RETRYABLE_DEFAULTS                        │
└──────────────────────────────────────────────────────────────┘
```

---

## How It Works

The package handles the **selection + broadcast** phase — it does not spawn agents. Agent spawning is handled upstream by `@koi/parallel-minions`, `@koi/orchestrator`, or manual `createKoi()` calls. This package receives their outputs as `Proposal` objects.

```
┌──────────────────────────────────────────────────────────────┐
│                      USER REQUEST                            │
│              "Refactor the auth module"                       │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  @koi/parallel-minions  │  ← fan-out (existing)
              │  spawn N agents         │
              └────────────┬───────────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
     ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
     │  Agent A     │ │  Agent B     │ │  Agent C     │
     │  salience:   │ │  salience:   │ │  salience:   │
     │    0.6       │ │    0.9       │ │    0.3       │
     └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
            │                │                │
            │         Collect as Proposals     │
            └────────────────┼────────────────┘
                             │
                             ▼
     ┌───────────────────────────────────────────────────────┐
     │           @koi/competitive-broadcast                  │
     │                                                       │
     │  ┌─────────────────────────────────────────────────┐  │
     │  │  1. VALIDATE  — count, duplicates, abort signal │  │
     │  ├─────────────────────────────────────────────────┤  │
     │  │  2. TRUNCATE  — cap output per maxOutputPerProposal│ │
     │  ├─────────────────────────────────────────────────┤  │
     │  │  3. SELECT    — pluggable SelectionStrategy     │  │
     │  │     first-wins / scored / consensus              │  │
     │  ├─────────────────────────────────────────────────┤  │
     │  │  4. BROADCAST — pluggable BroadcastSink         │  │
     │  │     Delivers winner to all recipients            │  │
     │  └─────────────────────────────────────────────────┘  │
     │                                                       │
     │  Returns: Result<BroadcastResult, KoiError>           │
     │  Events:  selection_started → winner_selected →       │
     │           broadcast_started → broadcast_complete       │
     └───────────────────────────────────────────────────────┘
                             │
                             ▼
                    ALL AGENTS RECEIVE WINNER
                    (system-wide coherence)
```

---

## The Proposal Model

A `Proposal` represents one agent's competing output:

```typescript
interface Proposal {
  readonly id: ProposalId;           // Branded string (compile-time safety)
  readonly agentId: AgentId;         // Which agent produced this
  readonly output: string;           // The agent's response text
  readonly durationMs: number;       // How long the agent took
  readonly submittedAt: number;      // Epoch ms — when the agent submitted
  readonly salience?: number;        // 0-1, used by scored selection
  readonly metadata?: Readonly<Record<string, unknown>>;
}
```

`ProposalId` is a branded type — prevents accidentally mixing it with other string IDs at compile time:

```typescript
import { proposalId } from "@koi/competitive-broadcast";

const id = proposalId("my-proposal");  // ProposalId (branded)
```

---

## Selection Strategies

Three built-in factories. All return `Result<Proposal, KoiError>` — never throw.

### createFirstWinsSelector()

Picks the proposal with the **lowest `submittedAt`** (earliest submission).

```
  Agent A (1.2s)  ──┐
  Agent B (3.1s)  ──┼─→ first-wins ─→ Agent C (fastest)
  Agent C (0.8s)  ──┘
```

**Tiebreaker chain:** lowest `submittedAt` → highest `salience` → lexicographic `id`

**Use case:** Fastest acceptable answer. Race models of different sizes — Haiku answers in 0.8s, Opus in 9s, first one wins.

### createScoredSelector(scoreFn?)

Picks the proposal with the **highest score**. Default scorer: `salience ?? 0`. Custom `scoreFn` overrides.

```
  Agent A (salience: 0.6)  ──┐
  Agent B (salience: 0.9)  ──┼─→ scored ─→ Agent B (highest score)
  Agent C (salience: 0.3)  ──┘
```

**NaN/Infinity handling:** Treated as 0 (sanitized before comparison).

**Custom scorers:**

```typescript
// Score by output length (most thorough wins)
createScoredSelector((p) => p.output.length);

// Score by speed (fastest wins)
createScoredSelector((p) => 1 / p.durationMs);

// Score by keyword presence
createScoredSelector((p) => p.output.includes("SOLUTION") ? 1 : 0);
```

**Use case:** Best-of-N code generation. Quality-based ranking.

### createConsensusSelector(options)

Selects the proposal that exceeds a **vote-based threshold**. An async `judge` callback evaluates proposals and returns votes.

```typescript
createConsensusSelector({
  threshold: 0.6,            // Must exceed 60% of total vote score
  judge: async (proposals) => [
    { proposalId: proposalId("a"), score: 0.8 },
    { proposalId: proposalId("b"), score: 0.2 },
  ],
})
```

```
  Proposal A: 0.8 / 1.0 = 80%  ──→ exceeds 60% threshold ──→ WINNER
  Proposal B: 0.2 / 1.0 = 20%  ──→ below threshold
```

**Threshold validation:** Must be in `[0, 1]`. Throws `RangeError` at construction time if invalid.

**Use case:** Consensus validation ("Is this SQL query safe?" — 3 judges vote), ensemble agreement.

---

## Broadcast Sinks

Two built-in implementations. Both implement the `BroadcastSink` interface.

### createInMemoryBroadcastSink(recipients)

Calls each recipient callback in parallel via `Promise.allSettled`. Never throws — failures are counted in the report.

```typescript
const sink = createInMemoryBroadcastSink([
  async (result) => { agentA.receive(result.winner); },
  async (result) => { agentB.receive(result.winner); },
  async (result) => { agentC.receive(result.winner); },
]);
```

**Delivery report:**

```typescript
interface BroadcastReport {
  readonly delivered: number;   // Successful callbacks
  readonly failed: number;      // Failed callbacks
  readonly errors?: readonly unknown[];
}
```

### createEventBroadcastSink(eventComponent)

Emits a `"broadcast:winner"` event to an `EventComponent` event bus.

```typescript
const sink = createEventBroadcastSink(eventComponent);
// Emits: eventComponent.emit("broadcast:winner", result)
```

**Use case:** Wire into Koi's event system or any pub/sub bus.

---

## The runCycle() Pipeline

The core function. Stateless — safe to call concurrently.

```typescript
async function runCycle(
  config: CycleConfig,
  proposals: readonly Proposal[],
): Promise<Result<BroadcastResult, KoiError>>
```

**Pipeline steps:**

```
1. Check AbortSignal     → TIMEOUT error if already aborted
2. Validate proposals     → VALIDATION error if empty, < minProposals, or duplicate IDs
3. Truncate outputs       → Cap each output to maxOutputPerProposal chars
4. Fire selection_started → onEvent callback
5. Run strategy.select()  → INTERNAL error if strategy throws
6. Fire winner_selected   → onEvent callback
7. Check AbortSignal      → TIMEOUT error if aborted mid-cycle
8. Fire broadcast_started → onEvent callback
9. Run sink.broadcast()   → INTERNAL error if sink throws
10. Fire broadcast_complete→ onEvent callback
11. Return Result          → { ok: true, value: BroadcastResult }
```

**Never throws.** All failures are returned as `Result.error` with appropriate `KoiError` codes.

---

## Configuration

```typescript
interface CycleConfig {
  readonly strategy: SelectionStrategy;           // Required: how to pick a winner
  readonly sink: BroadcastSink;                   // Required: how to deliver
  readonly minProposals: number;                  // Default: 1
  readonly maxOutputPerProposal: number;          // Default: 10,000 chars
  readonly signal?: AbortSignal;                  // Optional: cancel the cycle
  readonly onEvent?: (event: CycleEvent) => void; // Optional: lifecycle events
}
```

**Defaults:**

```typescript
const DEFAULT_CYCLE_CONFIG = Object.freeze({
  minProposals: 1,
  maxOutputPerProposal: 10_000,
});
```

**Validation:**

```typescript
import { validateCycleConfig } from "@koi/competitive-broadcast";

const result = validateCycleConfig(rawConfig);
if (!result.ok) console.error(result.error.message);
```

---

## Cycle Events

Observable lifecycle events via the `onEvent` callback. Discriminated union on `kind`:

| Event | Payload | When |
|-------|---------|------|
| `selection_started` | `{ proposalCount: number }` | Before strategy.select() |
| `winner_selected` | `{ winner: Proposal }` | After successful selection |
| `broadcast_started` | `{ winnerId: ProposalId }` | Before sink.broadcast() |
| `broadcast_complete` | `{ report: BroadcastReport }` | After successful broadcast |
| `cycle_error` | `{ error: KoiError }` | On any failure (validation, strategy, broadcast) |

**Safety:** If `onEvent` throws, the cycle continues — observer errors never crash the pipeline.

---

## Composing with Other Packages

### With @koi/parallel-minions (spawn + compete)

```typescript
import { createParallelMinionsProvider } from "@koi/parallel-minions";
import { runCycle, createScoredSelector, createInMemoryBroadcastSink, proposalId } from "@koi/competitive-broadcast";
import { agentId } from "@koi/core/ecs";

// 1. Spawn agents via parallel-minions
const minionResults = await runParallelTasks([
  { description: "Implement rate limiter with token bucket" },
  { description: "Implement rate limiter with sliding window" },
  { description: "Implement rate limiter with leaky bucket" },
]);

// 2. Convert results to Proposals
const proposals = minionResults.map((r, i) => ({
  id: proposalId(`approach-${i}`),
  agentId: agentId(`minion-${i}`),
  output: r.output,
  durationMs: r.durationMs,
  submittedAt: r.submittedAt,
  salience: r.qualityScore,
}));

// 3. Run competitive selection + broadcast
const result = await runCycle(
  {
    strategy: createScoredSelector(),
    sink: createInMemoryBroadcastSink(recipients),
    minProposals: 2,
    maxOutputPerProposal: 5_000,
  },
  proposals,
);
```

### With @koi/engine-external (CLI tools compete)

Works with any engine adapter — including external processes. The `Proposal` interface is the common contract; the adapter behind it is invisible to competitive-broadcast.

```typescript
import { createExternalAdapter } from "@koi/engine-external";
import { createKoi } from "@koi/engine";

// Spawn a Python script and a Rust solver via engine-external
const pythonAdapter = createExternalAdapter({ command: "python", args: ["solver.py"] });
const rustAdapter = createExternalAdapter({ command: "./target/release/solver" });

// Both go through createKoi → collect outputs → build Proposals → runCycle()
```

**Note:** `engine-external` reports zero tokens in metrics. Use a custom `scoreFn` instead of salience:

```typescript
createScoredSelector((p) => 1 / p.durationMs);  // fastest wins
```

### With @koi/engine-pi (LLM agents compete)

```typescript
import { createPiAdapter } from "@koi/engine-pi";

const agents = ["haiku", "sonnet", "opus"].map((model) =>
  createPiAdapter({
    model: `anthropic:claude-${model}-...`,
    getApiKey: async () => API_KEY,
  })
);

// Spawn all through createKoi, collect outputs, feed into runCycle()
```

---

## Adapter Compatibility

Competitive-broadcast is **adapter-agnostic**. It works with any source that produces `Proposal` objects:

```
                         ┌─────────────────┐
                         │  Same task       │
                         └────────┬────────┘
                 ┌────────────────┼────────────────┐
                 ▼                ▼                 ▼
          ┌─────────────┐ ┌──────────────┐ ┌──────────────┐
          │ engine-pi    │ │engine-external│ │engine-loop   │
          │ (Claude LLM) │ │ (Python CLI) │ │ (OpenRouter) │
          └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
                 │                │                 │
                 ▼                ▼                 ▼
          ┌──────────────────────────────────────────────┐
          │              Proposal[]                       │
          │  (adapter type is invisible at this layer)    │
          └──────────────────────┬───────────────────────┘
                                 │
                                 ▼
                          ┌─────────────┐
                          │  runCycle()  │
                          └─────────────┘
```

---

## Real-World Patterns

### Best-of-N Code Generation

```
  "Implement a rate limiter"
     │
     ├─→ Agent 1: token bucket    ──┐
     ├─→ Agent 2: sliding window  ──┼─→ scored(quality) ─→ best one
     └─→ Agent 3: leaky bucket    ──┘
```

### Consensus Validation

```
  "Is this SQL query safe?"
     │
     ├─→ Judge 1: "yes, safe"     ──┐
     ├─→ Judge 2: "yes, safe"     ──┼─→ consensus(0.66) ─→ safe
     └─→ Judge 3: "no, injection" ──┘
```

### Fastest Acceptable Answer

```
  "Summarize this document"
     │
     ├─→ Haiku  (0.8s)  ──┐
     ├─→ Sonnet (3.1s)  ──┼─→ first-wins ─→ Haiku's answer
     └─→ Opus   (9.2s)  ──┘
```

### A/B Model Testing

```
  Same prompt → different models
     │
     ├─→ Claude  ──┐
     ├─→ GPT-4o  ──┼─→ scored(quality) ─→ track winner % per model
     └─→ Gemini  ──┘      over 1000 runs
```

---

## Error Handling

All errors are returned as `Result<BroadcastResult, KoiError>` — never thrown.

| Error Code | When | Retryable |
|------------|------|-----------|
| `VALIDATION` | Empty proposals, below minProposals, duplicate IDs | No |
| `VALIDATION` | No consensus reached (below threshold) | No |
| `TIMEOUT` | AbortSignal already aborted or aborted mid-cycle | Yes |
| `INTERNAL` | strategy.select() threw unexpectedly | Depends |
| `INTERNAL` | sink.broadcast() threw unexpectedly | Depends |

**Error shape:**

```typescript
interface KoiError {
  readonly code: "VALIDATION" | "TIMEOUT" | "INTERNAL";
  readonly message: string;      // Human-readable: what + why + what to do
  readonly retryable: boolean;
  readonly cause?: unknown;      // Original error (for INTERNAL)
  readonly context?: Readonly<Record<string, unknown>>;
}
```

---

## API Reference

### Core Function

| Function | Returns | Description |
|----------|---------|-------------|
| `runCycle(config, proposals)` | `Promise<Result<BroadcastResult, KoiError>>` | Execute the full selection + broadcast pipeline |

### Selection Strategy Factories

| Function | Returns | Description |
|----------|---------|-------------|
| `createFirstWinsSelector()` | `SelectionStrategy` | Picks earliest `submittedAt` |
| `createScoredSelector(scoreFn?)` | `SelectionStrategy` | Picks highest score (default: salience) |
| `createConsensusSelector(options)` | `SelectionStrategy` | Picks proposal exceeding vote threshold |

### Broadcast Sink Factories

| Function | Returns | Description |
|----------|---------|-------------|
| `createInMemoryBroadcastSink(recipients)` | `BroadcastSink` | Parallel delivery via `Promise.allSettled` |
| `createEventBroadcastSink(eventComponent)` | `BroadcastSink` | Emits `"broadcast:winner"` event |

### Config

| Export | Type | Description |
|--------|------|-------------|
| `validateCycleConfig(raw)` | `(unknown) => Result<CycleConfig, KoiError>` | Schema validation with defaults |
| `DEFAULT_CYCLE_CONFIG` | `{ minProposals: 1, maxOutputPerProposal: 10_000 }` | Frozen defaults |

### Branded Constructors + Type Guards

| Function | Returns | Description |
|----------|---------|-------------|
| `proposalId(id)` | `ProposalId` | Branded string constructor |
| `isProposal(value)` | `value is Proposal` | Runtime type guard |

### Types

| Type | Description |
|------|-------------|
| `Proposal` | Competing agent output with id, agentId, output, timing, salience |
| `ProposalId` | Branded string for compile-time safety |
| `SelectionStrategy` | `{ name, select(proposals) → Result }` |
| `BroadcastSink` | `{ broadcast(result) → Promise<BroadcastReport> }` |
| `BroadcastResult` | `{ winner, allProposals, cycleId }` |
| `BroadcastReport` | `{ delivered, failed, errors? }` |
| `CycleConfig` | Strategy, sink, limits, signal, onEvent |
| `CycleEvent` | Discriminated union (5 event kinds) |
| `Vote` | `{ proposalId, score }` for consensus |
| `ConsensusOptions` | `{ threshold, judge }` for consensus selector |

---

## Layer Compliance

```
L0  @koi/core ─────────────────────────────────────────────┐
    KoiError, Result, RETRYABLE_DEFAULTS, AgentId           │
                                                            ▼
L2  @koi/competitive-broadcast <────────────────────────────┘
    imports from L0 only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    x zero external dependencies
    ~ package.json: { "dependencies": { "@koi/core": "workspace:*" } }
```
