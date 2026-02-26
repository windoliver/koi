# @koi/middleware-semantic-retry — Implementation Plan

Issue: #329 — context-aware prompt rewriting on agent failure ("Ralph Loop V2")

## Design Decisions (all approved)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Package relationship | Independent (ralph + guided-retry + semantic-retry) |
| 2 | Interface location | In L2 package |
| 3 | Hook strategy | wrapModelCall + wrapToolCall |
| 4 | Retry action model | Discriminated union with `kind` field |
| 5 | Analyzer interface | Two-phase: classify() + selectAction() |
| 6 | State management | Internal mutable state + immutable snapshots |
| 7 | Defaults | Ship defaults + allow override |
| 8 | DRY with guided-retry | Tolerate duplication (Rule of Three) |
| 9 | Test structure | Unit per module + integration |
| 10 | Escalation testing | Table-driven scenarios |
| 11 | Rewriter testing | describe-per-action + helpers |
| 12 | Edge cases | Full 8-item checklist |
| 13 | Hot path | Guard-clause fast path |
| 14 | Budget | Global maxRetries |
| 15 | Memory | Rolling window (last N records) |
| 16 | Analyzer timeout | Configurable timeout + safe fallback |

## Phase 1: Package Scaffolding

- [ ] Create `packages/middleware-semantic-retry/` directory
- [ ] Create `package.json` (deps: @koi/core; devDeps: @koi/test-utils)
- [ ] Create `tsconfig.json` (extends base, references core)
- [ ] Create `tsup.config.ts` (ESM-only, .d.ts)
- [ ] Wire into turbo pipeline

## Phase 2: Types (`src/types.ts`)

- [ ] `FailureClass` — discriminated union:
  - `hallucination` — model fabricated information
  - `tool_misuse` — wrong tool, wrong args, ignored output
  - `scope_drift` — agent went off-task
  - `token_exhaustion` — context window depleted
  - `api_error` — model API returned error (rate limit, timeout, etc.)
  - `validation_failure` — output failed schema/format check
  - `unknown` — catch-all
- [ ] `RetryAction` — discriminated union:
  - `narrow_scope` — reduce task scope, focus on specific area
  - `add_context` — inject additional context/error info
  - `redirect` — suggest different approach
  - `decompose` — break into subtasks
  - `escalate_model` — switch to more capable model
  - `abort` — stop retrying, propagate failure
- [ ] `FailureContext` — what the analyzer receives:
  - error (the caught error/failure)
  - request (the ModelRequest or ToolRequest that failed)
  - records (readonly RetryRecord[] — history)
  - turnIndex, callIndex
- [ ] `RetryRecord` — one entry per retry attempt:
  - timestamp, failureClass, actionTaken, succeeded
- [ ] `FailureAnalyzer` interface:
  - `classify(ctx: FailureContext): FailureClass | Promise<FailureClass>`
  - `selectAction(failure: FailureClass, records: readonly RetryRecord[]): RetryAction`
- [ ] `PromptRewriter` interface:
  - `rewrite(request: ModelRequest, action: RetryAction, ctx: RewriteContext): ModelRequest | Promise<ModelRequest>`
- [ ] `RewriteContext` — what the rewriter receives:
  - failureClass, records, turnIndex
- [ ] `SemanticRetryConfig`:
  - analyzer? (default: createDefaultFailureAnalyzer())
  - rewriter? (default: createDefaultPromptRewriter())
  - maxRetries? (default: 3)
  - maxHistorySize? (default: 20)
  - analyzerTimeoutMs? (default: 5000)
  - rewriterTimeoutMs? (default: 5000)
  - onRetry? callback for observability
- [ ] `SemanticRetryHandle`:
  - middleware: KoiMiddleware
  - getRecords(): readonly RetryRecord[]
  - getRetryBudget(): number
  - reset(): void

## Phase 3: Default Analyzer (`src/default-analyzer.ts`)

- [ ] `createDefaultFailureAnalyzer(): FailureAnalyzer`
- [ ] `classify()` — pattern-match on:
  - KoiError codes (TIMEOUT → api_error, VALIDATION → validation_failure, etc.)
  - Error message patterns (regex for common LLM failure messages)
  - Fallback to `unknown`
- [ ] `selectAction()` — escalation ladder:
  - 0 prior retries → `add_context` (least disruptive)
  - 1 prior retry → `narrow_scope`
  - 2 prior retries → `escalate_model` (if same failure class repeats)
  - 2 prior retries → `redirect` (if failure class changed)
  - 3+ prior retries → `abort`
  - `decompose` — triggered when scope_drift is detected
  - The ladder is configurable via an optional escalation config

## Phase 4: Default Rewriter (`src/default-rewriter.ts`)

- [ ] `createDefaultPromptRewriter(): PromptRewriter`
- [ ] Per-action rewriting:
  - `narrow_scope` — prepend message: "Focus specifically on: {focusArea}. Do not attempt anything beyond this scope."
  - `add_context` — prepend message: "Previous attempt failed: {error context}. Consider this information."
  - `redirect` — prepend message: "Previous approach failed. Try a different approach: {newApproach}"
  - `decompose` — prepend message: "Break this into steps: {subtasks}. Complete them one at a time."
  - `escalate_model` — set `request.model` to `targetModel`, prepend explanation
  - `abort` — throw error with abort reason (no rewriting)

## Phase 5: Middleware Core (`src/semantic-retry.ts`)

- [ ] `createSemanticRetryMiddleware(config: SemanticRetryConfig): SemanticRetryHandle`
- [ ] Internal state:
  - `let records: readonly RetryRecord[] = []`
  - `let pendingAction: RetryAction | undefined`
  - `let budget: number = config.maxRetries ?? 3`
- [ ] `wrapModelCall(ctx, req, next)`:
  1. Guard clause: if `pendingAction === undefined`, return `next(req)`
  2. If `pendingAction.kind === "abort"`, throw with abort reason
  3. Call `rewriter.rewrite(req, pendingAction, rewriteCtx)` with timeout
  4. Clear `pendingAction`
  5. Call `next(modifiedReq)` — catch errors
  6. On success: record success, return response
  7. On error: call `analyzer.classify(failureCtx)` with timeout
  8. Call `analyzer.selectAction(failureClass, records)`
  9. Record the retry attempt
  10. Set `pendingAction` for next model call
  11. Trim records to `maxHistorySize`
  12. Decrement `budget` — if 0, force `abort`
  13. Re-throw the error (engine will make another call)
- [ ] `wrapToolCall(ctx, req, next)`:
  1. Guard clause: return `next(req)` (observe only)
  2. Catch errors from `next(req)`
  3. Call `analyzer.classify()` with tool failure context
  4. Call `analyzer.selectAction()`
  5. Set `pendingAction` for next model call
  6. Trim records, decrement budget
  7. Re-throw the tool error
- [ ] Handle edge cases:
  - Analyzer throws → fall back to `add_context`
  - Rewriter throws → pass original request unchanged
  - AbortSignal → respect immediately
  - Budget exhaustion → force abort action
- [ ] Middleware priority: 420 (just inside guided-retry's 425)
- [ ] Expose control API: `getRecords()`, `getRetryBudget()`, `reset()`

## Phase 6: Tests

### Unit Tests (colocated)

- [ ] `src/default-analyzer.test.ts`:
  - classify() maps KoiError codes correctly
  - classify() falls back to `unknown` for unrecognized errors
  - selectAction() escalation ladder: table-driven scenarios
  - selectAction() uses `decompose` for scope_drift
  - selectAction() returns `abort` when budget exhausted
- [ ] `src/default-rewriter.test.ts`:
  - describe("narrow_scope"): prepends focus guidance, preserves original messages
  - describe("add_context"): injects error context
  - describe("redirect"): suggests new approach
  - describe("decompose"): lists subtasks
  - describe("escalate_model"): sets request.model + explains
  - describe("abort"): throws with reason
  - Shared helpers: assertInjectedMessage(), assertOriginalPreserved()
- [ ] `src/semantic-retry.test.ts`:
  - Passthrough when no failures
  - Middleware name and priority
  - Catches model call errors and sets pendingAction
  - Applies rewrite on subsequent model call
  - Catches tool call errors
  - Budget enforcement: stops retrying at maxRetries
  - Rolling window: trims records beyond maxHistorySize
  - Analyzer timeout: falls back to add_context
  - Rewriter timeout: passes original request
  - Abort signal: respected immediately
  - Custom analyzer/rewriter: overrides defaults
  - getRecords() / getRetryBudget() / reset() API

### Integration Tests

- [ ] `src/__tests__/escalation.test.ts`:
  - Table-driven escalation scenarios:
    - 1 failure → add_context → success
    - 2 failures → add_context → narrow_scope → success
    - 3 failures → add_context → narrow_scope → escalate_model → success
    - 4 failures → add_context → narrow_scope → escalate_model → abort
  - Non-linear: success mid-ladder resets state
  - Different failure classes take different paths
  - Interleaved tool + model failures

## Phase 7: Package Exports (`src/index.ts`)

- [ ] Export factory: `createSemanticRetryMiddleware`
- [ ] Export defaults: `createDefaultFailureAnalyzer`, `createDefaultPromptRewriter`
- [ ] Export types (with `export type`): all interfaces and discriminated unions
- [ ] No barrel re-exports — import from specific modules for internal use

## File Structure

```
packages/middleware-semantic-retry/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts                    # Public API exports
    types.ts                    # All interfaces, discriminated unions (~120 lines)
    default-analyzer.ts         # Default FailureAnalyzer (~100 lines)
    default-analyzer.test.ts    # Unit tests for analyzer
    default-rewriter.ts         # Default PromptRewriter (~120 lines)
    default-rewriter.test.ts    # Unit tests for rewriter
    semantic-retry.ts           # Middleware factory (~200 lines)
    semantic-retry.test.ts      # Unit tests for middleware
    __tests__/
      escalation.test.ts        # Integration tests (~150 lines)
```

Estimated: ~540 LOC source + ~600 LOC tests = ~1,140 LOC total

## Dependencies

- `@koi/core` (workspace:*) — L0 types (KoiMiddleware, ModelRequest, etc.)
- `@koi/test-utils` (workspace:*, dev) — mock helpers

No new external dependencies.

## Implementation Order (TDD)

1. Phase 1 (scaffolding)
2. Phase 2 (types) — types first, everything depends on them
3. Phase 6 partial (test shells) — RED: write failing tests for analyzer + rewriter
4. Phase 3 (default analyzer) — GREEN: make analyzer tests pass
5. Phase 4 (default rewriter) — GREEN: make rewriter tests pass
6. Phase 6 partial (middleware tests) — RED: write failing middleware tests
7. Phase 5 (middleware core) — GREEN: make middleware tests pass
8. Phase 6 remaining (integration + edge cases) — full coverage
9. Phase 7 (exports) — wire up public API
10. Verify: `bun test`, `bun run typecheck`, `bun run lint`
