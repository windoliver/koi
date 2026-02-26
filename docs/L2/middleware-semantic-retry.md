# @koi/middleware-semantic-retry — Context-Aware Prompt Rewriting on Agent Failure

Intercepts model and tool call failures, classifies them semantically, and rewrites the next prompt with targeted guidance so the LLM can adapt its strategy instead of repeating the same mistake. Pluggable analyzer and rewriter. Budget-tracked with progressive escalation.

---

## Why It Exists

When an LLM agent fails — a tool returns an error, an API times out, the model drifts off-task — the naive retry strategy is to re-send the same prompt and hope for a different result. This fails for two reasons:

1. **The LLM has no memory of the failure.** Without context, it repeats the exact same approach.
2. **Not all failures are the same.** A permission error needs a different response than a scope drift or a rate limit.

This middleware solves both problems:

- **Failure classification** — categorizes errors into semantic kinds (tool misuse, API error, validation failure, scope drift, unknown)
- **Prompt rewriting** — injects `[RETRY GUIDANCE]` messages that tell the LLM *what went wrong* and *how to adjust*
- **Progressive escalation** — starts with context injection, narrows scope, escalates to a stronger model, and aborts cleanly when budget is exhausted

Without this package, every agent that needs intelligent retry would reimplement failure classification, prompt injection, budget tracking, and escalation logic.

---

## Architecture

`@koi/middleware-semantic-retry` is an **L2 feature package** — it depends only on L0 (`@koi/core`). Zero external dependencies.

```
┌────────────────────────────────────────────────────────┐
│  @koi/middleware-semantic-retry  (L2)                   │
│                                                        │
│  types.ts             ← 13 types + discriminated unions│
│  default-analyzer.ts  ← pattern-matching classifier    │
│  default-rewriter.ts  ← per-action prompt rewriter     │
│  semantic-retry.ts    ← middleware factory + state      │
│  index.ts             ← public API surface             │
│                                                        │
├────────────────────────────────────────────────────────┤
│  Dependencies                                          │
│                                                        │
│  @koi/core   (L0)   KoiMiddleware, ModelRequest,       │
│                      ModelResponse, ToolRequest,        │
│                      ToolResponse, TurnContext,         │
│                      InboundMessage, JsonObject         │
└────────────────────────────────────────────────────────┘
```

---

## How It Works

### Without Semantic Retry

```
Agent call fails → same prompt retried → same failure → loop or crash
```

### With Semantic Retry

```
Agent call fails
      │
      ▼
┌─────────────────────────────────────┐
│  FailureAnalyzer.classify()         │
│  Error → FailureClass               │
│  { kind: "tool_misuse",             │
│    reason: "deploy() permission..." }│
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  FailureAnalyzer.selectAction()     │
│  FailureClass + history → action    │
│  { kind: "add_context",             │
│    context: "Permission denied..." } │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  PromptRewriter.rewrite()           │
│  action + request → modified request│
│  Prepends: "[RETRY GUIDANCE]        │
│   Previous attempt failed: ..."     │
└──────────────┬──────────────────────┘
               │
               ▼
Agent receives modified prompt → adapts strategy → succeeds
```

### Middleware Position (Onion)

```
                Incoming Model Call
                       │
                       ▼
           ┌───────────────────────┐
           │   middleware-audit     │  priority: 450
           ├───────────────────────┤
           │  middleware-guided-    │  priority: 425
           │  retry (structural)   │
           ├───────────────────────┤
        ┌──│  middleware-semantic-  │──┐  priority: 420
        │  │  retry (THIS)         │  │
        │  ├───────────────────────┤  │
        │  │  middleware-permissions│  │  priority: 400
        │  ├───────────────────────┤  │
        │  │  engine adapter       │  │
        │  │  → LLM API call       │  │
        │  └───────────┬───────────┘  │
        │         Response or Error   │
        │              │              │
        │   ┌──────────▼──────────┐   │
        └──▶│ On error:           │◀──┘
            │  classify → select  │
            │  → rewrite next call│
            └─────────────────────┘
```

---

## Escalation Ladder

The default analyzer implements a progressive escalation strategy based on retry count:

```
Failure #   Budget    Action             What Happens
──────────────────────────────────────────────────────────────
    1       3 → 2     add_context        "Here's what went wrong: ..."
    2       2 → 1     narrow_scope       "Focus ONLY on: ..."
    3       1 → 0     escalate_model     Switch to stronger model
                      OR redirect        "Try a different strategy"
    4       0         abort              Clean exit, no infinite loop
```

Special case: `scope_drift` failures always trigger `decompose` (break into subtasks) regardless of retry count.

When the same `FailureClassKind` repeats consecutively, the ladder escalates to `escalate_model` (switch to a more capable model). When failure kinds alternate, it uses `redirect` (try a different approach).

---

## Failure Classification

### 5 Failure Kinds

| Kind | Trigger | Example |
|------|---------|---------|
| `api_error` | KoiError codes: TIMEOUT, RATE_LIMIT, EXTERNAL, PERMISSION, CONFLICT | API rate limited, network timeout |
| `tool_misuse` | KoiError NOT_FOUND, or any tool call failure | Tool doesn't exist, wrong arguments |
| `validation_failure` | KoiError VALIDATION | Schema mismatch, bad input format |
| `scope_drift` | Custom analyzer detects task divergence | Agent wandered off-task |
| `unknown` | Unrecognized error, KoiError INTERNAL/STALE_REF | Unexpected failures |

### Classification Pipeline

```
Error
  │
  ├─ Has KoiError code? ──yes──▶ Map code → FailureClassKind
  │
  ├─ Is tool failure? ────yes──▶ tool_misuse
  │
  └─ Fallback ─────────────────▶ unknown
```

The default analyzer is synchronous. Custom analyzers can be async (e.g., call an LLM to classify the failure) — the middleware races them against a configurable timeout with automatic fallback.

---

## 6 Retry Actions

| Action | What the Rewriter Does |
|--------|----------------------|
| `add_context` | Prepends: "Previous attempt failed: {reason}. Use this info to avoid the same mistake." |
| `narrow_scope` | Prepends: "Focus specifically on: {focusArea}. Do not attempt anything beyond this scope." |
| `redirect` | Prepends: "Try a different approach: {newApproach}. Avoid repeating the previous strategy." |
| `decompose` | Prepends: "Break this into smaller steps: 1. {subtask1} 2. {subtask2} ..." |
| `escalate_model` | Prepends guidance + changes `request.model` to a stronger model |
| `abort` | Throws `Error("Semantic retry aborted: {reason}")` — clean exit |

All rewriting is **non-mutating** — the rewriter returns a new `ModelRequest` with the guidance message prepended to `messages[]`. The original request is never modified.

---

## Hot Path Performance

The middleware adds near-zero overhead on the success path (99% of calls):

```
wrapModelCall(ctx, request, next):
  │
  ├── pendingAction === undefined?     ← 1 check (fast path)
  │     yes → return await next(request)   ← straight through
  │     no  → rewrite + next              ← only on retry
  │
  └── catch → handleFailure()          ← only on error
```

**Success path:** 1 undefined check + delegate to `next()`. Zero allocations.

**Failure path:** classify (up to 5s timeout) + select action (sync) + record (1 object allocation). Bounded by `maxHistorySize` (default: 20 records).

---

## API Reference

### Factory Functions

#### `createSemanticRetryMiddleware(config)`

Creates the middleware with state management and retry logic.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.analyzer` | `FailureAnalyzer` | Default pattern-matcher | Pluggable failure classifier |
| `config.rewriter` | `PromptRewriter` | Default prompt injector | Pluggable prompt rewriter |
| `config.maxRetries` | `number` | `3` | Retry budget per session |
| `config.maxHistorySize` | `number` | `20` | Max retained failure records |
| `config.analyzerTimeoutMs` | `number` | `5000` | Timeout for `classify()` |
| `config.rewriterTimeoutMs` | `number` | `5000` | Timeout for `rewrite()` |
| `config.onRetry` | `OnRetryCallback` | — | Fires on every retry decision |

**Returns:** `SemanticRetryHandle`

```typescript
interface SemanticRetryHandle {
  readonly middleware: KoiMiddleware      // Register in your agent
  readonly getRecords: () => readonly RetryRecord[]  // Immutable history
  readonly getRetryBudget: () => number  // Remaining retries
  readonly reset: () => void             // Reset state for new session
}
```

#### `createDefaultFailureAnalyzer()`

Returns a `FailureAnalyzer` with KoiError code mapping and escalation ladder.

#### `createDefaultPromptRewriter()`

Returns a `PromptRewriter` that handles all 6 action kinds with message injection.

### Interfaces

#### `FailureAnalyzer`

```typescript
interface FailureAnalyzer {
  readonly classify: (ctx: FailureContext) => FailureClass | Promise<FailureClass>
  readonly selectAction: (failure: FailureClass, records: readonly RetryRecord[]) => RetryAction
}
```

`classify` may be async (e.g., LLM-based classification). The middleware races it against `analyzerTimeoutMs` and falls back to `{ kind: "unknown" }` on timeout or error.

#### `PromptRewriter`

```typescript
interface PromptRewriter {
  readonly rewrite: (
    request: ModelRequest,
    action: RetryAction,
    ctx: RewriteContext,
  ) => ModelRequest | Promise<ModelRequest>
}
```

For `abort` actions, the default rewriter throws instead of returning a modified request.

### Types

| Type | Description |
|------|-------------|
| `FailureClass` | `{ kind: FailureClassKind, reason: string }` |
| `FailureClassKind` | `"api_error" \| "tool_misuse" \| "validation_failure" \| "scope_drift" \| "unknown"` |
| `RetryAction` | Discriminated union — 6 kinds (see table above) |
| `RetryActionKind` | Union of the 6 action kind strings |
| `RetryRecord` | `{ timestamp, failureClass, actionTaken, succeeded }` |
| `FailureContext` | `{ error, request, records, turnIndex }` |
| `RewriteContext` | `{ failureClass, records, turnIndex }` |
| `ToolFailureRequest` | `{ kind: "tool", toolId, input }` |
| `SemanticRetryConfig` | Configuration for `createSemanticRetryMiddleware()` |
| `SemanticRetryHandle` | Return type with middleware + state accessors |
| `OnRetryCallback` | `(record: RetryRecord) => void` |

---

## Examples

### Basic Usage

```typescript
import { createSemanticRetryMiddleware } from "@koi/middleware-semantic-retry";

const { middleware, getRecords, getRetryBudget } = createSemanticRetryMiddleware({
  maxRetries: 3,
});

// Register in your Koi agent assembly:
const agent = await createKoi({
  manifest,
  middleware: [middleware],
});

// Observe retry history:
console.log(getRecords());      // readonly RetryRecord[]
console.log(getRetryBudget());  // 3 (decrements on each failure)
```

### With Observability Callback

```typescript
const { middleware } = createSemanticRetryMiddleware({
  onRetry(record) {
    console.log(`[retry] ${record.failureClass.kind}: ${record.actionTaken.kind}`);
    metrics.increment("agent.retry", {
      failure_kind: record.failureClass.kind,
      action_kind: record.actionTaken.kind,
    });
  },
});
```

### Custom Analyzer (LLM-Based Classification)

```typescript
import type { FailureAnalyzer } from "@koi/middleware-semantic-retry";

const llmAnalyzer: FailureAnalyzer = {
  async classify(ctx) {
    // Call a fast model to classify the failure
    const response = await classifyWithLLM(ctx.error, ctx.request);
    return { kind: response.kind, reason: response.explanation };
  },
  selectAction(failure, records) {
    // Custom escalation logic
    if (failure.kind === "scope_drift") {
      return { kind: "decompose", subtasks: ["Re-read requirements", "Focus on step 1"] };
    }
    if (records.length >= 2) {
      return { kind: "abort", reason: "Too many failures" };
    }
    return { kind: "add_context", context: failure.reason };
  },
};

const { middleware } = createSemanticRetryMiddleware({
  analyzer: llmAnalyzer,
  analyzerTimeoutMs: 10_000, // allow more time for LLM classification
});
```

### With Other Middleware

```typescript
import { createSemanticRetryMiddleware } from "@koi/middleware-semantic-retry";
import { createAuditMiddleware } from "@koi/middleware-audit";
import { createGuidedRetryMiddleware } from "@koi/middleware-guided-retry";

const agent = await createKoi({
  manifest,
  middleware: [
    createAuditMiddleware({ ... }),            // priority: 450 (outermost)
    createGuidedRetryMiddleware({ ... }),       // priority: 425
    createSemanticRetryMiddleware({ ... }).middleware,  // priority: 420
  ],
});
```

### Session Reset

```typescript
const handle = createSemanticRetryMiddleware({ maxRetries: 3 });

// After a conversation ends, reset for the next session:
handle.reset();
// Budget restored, records cleared, pending action cleared
```

---

## End-to-End Flow Example

```
User: "Deploy my app to staging"
         │
         ▼
┌──────────────────┐
│  Agent (Haiku)   │
│  "I'll deploy..."│
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Tool: deploy()  │──── FAIL: "Permission denied: missing IAM role"
└────────┬─────────┘
         │
    ┌────▼───────────────────────────────────┐
    │  Semantic Retry Middleware              │
    │                                        │
    │  1. Classify: tool_misuse              │
    │  2. Budget:   3 → 2                    │
    │  3. Action:   add_context              │
    │  4. Rewrite:  inject failure context   │
    └────────────────────────┬───────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  Agent (Haiku) — REWRITTEN PROMPT       │
│                                         │
│  "[RETRY GUIDANCE] Previous attempt     │
│   failed: Permission denied: missing    │
│   IAM role. Use this info to avoid      │
│   the same mistake."                    │
│                                         │
│  "I need to check IAM roles first..."   │
└────────┬────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│  Tool: iam_check │──── OK
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Tool: deploy()  │──── SUCCESS
└──────────────────┘
```

---

## Timeout and Fallback Safety

Both the analyzer and rewriter are guarded against hanging or crashing:

```
┌──────────────────────────────────┐
│  Analyzer/Rewriter Call          │
│                                  │
│  ┌──────────┐    ┌───────────┐  │
│  │ Promise  │    │ Timeout   │  │
│  │ .race()  │ vs │ (default  │  │
│  │          │    │  5000ms)  │  │
│  └─────┬────┘    └─────┬─────┘  │
│        │               │        │
│   Winner resolves:     │        │
│   - Normal → use result│        │
│   - Timeout → fallback │        │
│   - Throw → fallback   │        │
└──────────────────────────────────┘

Fallback behavior:
  - Analyzer timeout/error → { kind: "unknown" } + add_context action
  - Rewriter timeout/error → original request unchanged (no rewrite)
```

The `finally` block always clears the timer — no timer leaks even on early resolution.

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────────┐
    KoiMiddleware, ModelRequest, ModelResponse,            │
    ToolRequest, ToolResponse, TurnContext,                │
    InboundMessage, JsonObject                             │
                                                           │
                                                           ▼
L2  @koi/middleware-semantic-retry ◄───────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
```

**Dev-only dependency** (`@koi/test-utils`) is used in tests but is not a runtime import.
