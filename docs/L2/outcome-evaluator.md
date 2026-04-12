# @koi/outcome-evaluator — LLM-as-judge Rubric Iteration Loop

Evaluates agent output against a structured rubric using a separate grader model call. Re-prompts the agent with structured per-criterion feedback until all required criteria pass or the iteration budget is exhausted.

---

## Why It Exists

Getting an LLM to produce high-quality output on the first attempt is unreliable. Without external evaluation, the agent has no way to know whether its response actually satisfied the goal criteria — it only knows what the next user message says.

This middleware solves both the evaluation and the feedback loop:

- **Rubric-graded evaluation** — a separate grader model call scores each criterion independently
- **Structured feedback** — failing criteria with gap descriptions are injected as the block reason for the next agent turn
- **Budget control** — a configurable max-iterations ceiling and a circuit breaker prevent infinite loops
- **Per-criterion isolation** — optional `isolateCriteria` mode prevents halo effects between criteria

Without this package, every agent workflow that needs quality gates would reimplement LLM-grading, feedback formatting, circuit breaking, and iteration budgeting.

---

## Architecture

`@koi/outcome-evaluator` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0u utilities (`@koi/errors`, `@koi/token-estimator`). Zero external dependencies.

```
┌──────────────────────────────────────────────────────────────┐
│  @koi/outcome-evaluator  (L2)                                 │
│                                                              │
│  types.ts              ← config, handle, event types         │
│  prompt-builder.ts     ← grader prompt construction          │
│  parse-grader-response.ts  ← fail-closed JSON parser         │
│  circuit-breaker.ts    ← consecutive-identical-failure guard │
│  outcome-evaluator.ts  ← middleware factory + session state  │
│  index.ts              ← public API surface                  │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Dependencies                                                │
│                                                              │
│  @koi/core   (L0)   OutcomeRubric, RubricCriterion,          │
│                      OutcomeEvaluation, KoiMiddleware,       │
│                      TurnContext, SessionContext, etc.       │
│  @koi/errors (L0u)  KoiRuntimeError.from()                   │
│  @koi/token-estimator (L0u)  estimateTokens()                │
└──────────────────────────────────────────────────────────────┘
```

---

## How It Works

```
Agent turn N
    │
    ├── wrapModelStream  ← captures assistant text chunks into session state
    │
    └── onBeforeStop
            │
            ├── collectArtifact()    ← use capturedText (or custom collector)
            │                           truncate if maxArtifactTokens exceeded
            │
            ├── emit "outcome.evaluation.start"
            │
            ├── runGrader()
            │   ├── single call:     buildGraderPrompt(rubric, artifact)
            │   │                    → one model call → parseGraderResponse()
            │   │
            │   └── isolated mode:   buildGraderPrompt(rubric, artifact, criterion)
            │                        → N parallel model calls → aggregate results
            │
            ├── circuit breaker check
            │   └── same failing set N consecutive times → allow through
            │
            ├── emit "outcome.evaluation.end"
            │
            ├── satisfied  → { kind: "continue" }   (agent completes normally)
            ├── circuit    → { kind: "continue" }   (safety valve)
            └── needs_revision → { kind: "block", reason: formatFeedback() }
                                    └── injected as next turn's user message by L1
```

---

## Wiring

### Minimum required — `maxStopRetries` must be raised when `maxIterations > 3`

```typescript
import { createKoi } from "@koi/engine";
import { createOutcomeEvaluatorMiddleware } from "@koi/outcome-evaluator";

const rubric: OutcomeRubric = {
  description: "Explain recursion clearly",
  criteria: [
    { name: "mentions_base_case", description: "Mentions a base case" },
    { name: "mentions_self_reference", description: "Mentions that a function calls itself" },
  ],
};

const { middleware } = createOutcomeEvaluatorMiddleware({
  rubric,
  graderModelCall: async (prompt, signal) => {
    // Use any model call here — must be isolated from agent conversation
    return myModelClient.complete(prompt, { signal });
  },
  maxIterations: 5,
  engineStopRetryCap: 5, // throws at construction if maxIterations > cap
});

const agent = await createKoi({
  // ...
  middleware: [middleware],
  input: {
    maxStopRetries: 5, // must match or exceed maxIterations
  },
});
```

**Important**: `maxStopRetries` in `EngineInput` controls how many times L1 will fire `onBeforeStop`. If `maxIterations > maxStopRetries`, the evaluator will never reach its iteration ceiling — the engine will stop iterating first. Pass `engineStopRetryCap` at construction time to get a fast-fail error if this would happen.

---

## Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `rubric` | `OutcomeRubric` | required | Criteria to evaluate against |
| `graderModelCall` | `(prompt, signal?) => Promise<string>` | required | Pre-bound grader call, isolated from agent history |
| `maxIterations` | `number` | `3` | Max `onBeforeStop` evaluations per session. Max 20. |
| `isolateCriteria` | `boolean` | `false` | One grader call per criterion (prevents halo effects) |
| `maxConcurrentGraderCalls` | `number` | all criteria | Concurrency limit when `isolateCriteria: true` |
| `circuitBreakConsecutiveIdenticalFailures` | `number` | `2` | Trip after N identical failing sets |
| `onGraderError` | `"fail_closed" \| "fail_open"` | `"fail_closed"` | Behavior when grader throws or returns unparseable output |
| `graderTimeoutMs` | `number` | `30_000` | Per-call timeout; on expiry applies `onGraderError` policy |
| `maxArtifactTokens` | `number` | none | Truncate artifact to last N tokens before grading |
| `artifactCollector` | `(ctx, capturedText) => string \| Promise<string>` | use `capturedText` | Custom artifact extractor |
| `engineStopRetryCap` | `number` | none | Throw at construction if `maxIterations > cap` |
| `onEvent` | `(event) => void` | none | Observability hook for ATIF wiring |

---

## Rubric Definition

```typescript
interface OutcomeRubric {
  readonly description: string;          // Overall task description sent to grader
  readonly criteria: readonly RubricCriterion[];
}

interface RubricCriterion {
  readonly name: string;                 // Unique identifier (used in feedback)
  readonly description: string;          // What the grader evaluates
  readonly required?: boolean;           // Default: true. false = advisory (won't block satisfied)
}
```

Advisory criteria (`required: false`) are evaluated and included in the response but do not prevent the `satisfied` result or appear in the block reason feedback.

---

## Default Artifact Collector Behavior

The artifact is the text captured from the agent's last model stream during the current turn. Specifically:

1. `wrapModelStream` intercepts every model call and accumulates `text_delta` chunks
2. Each new stream **overwrites** the previous capture (last stream wins = final agent response)
3. `onBeforeStop` reads the accumulated text as the artifact

This means the artifact is always the agent's **most recent textual output**, not the full conversation. For non-textual outputs (structured tool results, files, etc.) provide a custom `artifactCollector`.

If `capturedText` is empty and no `artifactCollector` is provided, the middleware emits a `grader_error` event and applies `onGraderError` policy. It does **not** throw out of the middleware chain.

---

## Criterion Isolation and Halo Effects

By default (`isolateCriteria: false`), all criteria are sent in a single grader prompt. This is faster but can produce halo effects — if one criterion strongly fails, the grader may penalize other criteria unfairly.

With `isolateCriteria: true`:
- Each criterion gets a separate grader call with `buildGraderPrompt(rubric, artifact, criterion)`
- The artifact and rubric description are still included for context, but only the target criterion appears in the evaluation section
- Results are aggregated: overall `satisfied` iff all required criteria pass across all calls
- Latency is ~N× higher; use `maxConcurrentGraderCalls` to limit parallelism

---

## Circuit Breaker Reset Semantics

The circuit breaker tracks the **set of failing required criterion names** across consecutive calls. It trips when the identical set appears `circuitBreakConsecutiveIdenticalFailures` times in a row.

Reset conditions:
- Any change to the failing set (including partial improvement like "A,B fail → only B fails")
- Evaluation reaches `satisfied` (explicit `circuitBreaker.reset()`)

Non-reset conditions:
- Partial improvement does **not** prevent the counter from incrementing on the **new** set — it just starts counting the new set from 1

Example with `circuitBreakConsecutiveIdenticalFailures: 2`:
```
iter 1: {A, B} fail → count=1, no trip
iter 2: {A, B} fail → count=2, TRIP → continue
```
```
iter 1: {A, B} fail → count=1 for {A,B}
iter 2: {B} fail    → count resets to 1 for {B}
iter 3: {B} fail    → count=2 for {B}, TRIP → continue
```

---

## Grader Error Policies

| `onGraderError` | Grader throws | Grader returns invalid JSON |
|-----------------|---------------|----------------------------|
| `"fail_closed"` (default) | `{ kind: "continue" }` | `{ kind: "continue" }` |
| `"fail_open"` | `{ kind: "block", reason: ... }` | `{ kind: "block", reason: ... }` |

**fail_closed** means "when in doubt, let the agent complete" — safe for production where grader availability is uncertain.

**fail_open** means "when in doubt, keep the agent in the loop" — use when evaluation is critical and false positives (unreviewed completions) are more dangerous than false negatives.

---

## Token Truncation

When `maxArtifactTokens` is set and the artifact exceeds that token estimate:

- The artifact is **tail-truncated**: the last `maxArtifactTokens * 4` characters are kept
- Rationale: the tail of a long response is the most recent and most relevant content
- An `"outcome.artifact.truncated"` event is emitted with `originalTokens` and `truncatedTo`
- Token estimation uses the same heuristic as `@koi/token-estimator` (4 chars/token)

---

## Observable Events

```typescript
type OutcomeEvaluationEvent =
  | { kind: "outcome.evaluation.start"; sessionId: string; iteration: number }
  | { kind: "outcome.evaluation.end";   sessionId: string; evaluation: OutcomeEvaluation }
  | { kind: "outcome.artifact.truncated"; sessionId: string; originalTokens: number; truncatedTo: number }
  | { kind: "outcome.grader.timeout";  sessionId: string; graderTimeoutMs: number };
```

Wire via `onEvent` config field:

```typescript
createOutcomeEvaluatorMiddleware({
  // ...
  onEvent: (event) => {
    if (event.kind === "outcome.evaluation.end") {
      telemetry.record("grader.result", {
        result: event.evaluation.result,
        iteration: event.evaluation.iteration,
        failingCriteria: event.evaluation.criteria.filter(c => !c.passed).map(c => c.name),
      });
    }
  },
});
```

---

## Public API

```typescript
import { createOutcomeEvaluatorMiddleware } from "@koi/outcome-evaluator";
import type {
  GraderModelCall,
  OutcomeEvaluationEvent,
  OutcomeEvaluatorConfig,
  OutcomeEvaluatorHandle,
  OutcomeEvaluatorStats,
} from "@koi/outcome-evaluator";

// L0 types re-exported from @koi/core:
import type {
  OutcomeRubric,
  RubricCriterion,
  OutcomeEvaluation,
  OutcomeEvaluationResult,
  CriterionResult,
} from "@koi/core";
```

`createOutcomeEvaluatorMiddleware(config)` returns an `OutcomeEvaluatorHandle`:

```typescript
interface OutcomeEvaluatorHandle {
  readonly middleware: KoiMiddleware;
  readonly getStats: (sessionId: SessionId) => OutcomeEvaluatorStats;
}

interface OutcomeEvaluatorStats {
  readonly totalEvaluations: number;
  readonly satisfied: number;
  readonly circuitBreaks: number;
  readonly graderErrors: number;
}
```

`getStats(sessionId)` returns a snapshot of evaluation statistics for the given session. Returns zeroed stats for unknown session IDs (i.e., after `onSessionEnd` is called or before any evaluation runs).
