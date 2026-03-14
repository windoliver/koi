# Issue #961 — Performance & Resilience (COMPLETE)

## Phase 1: Foundation & Cleanup (DONE)

- [x] `parseModelId()` + `extractProvider()` in `@koi/name-resolution` (L0u) + 13 tests
- [x] `createSideChannel<T>()` in `@koi/execution-context` (L0u) + 9 tests
- [x] Scheduler `emit()` — try-catch error isolation + 1 test
- [x] Gateway `updateAgentIndex()` — try-catch error isolation + idempotent unsub guard + 3 tests

## Phase 2: Prompt Cache Middleware (DONE)

- [x] Created `@koi/middleware-prompt-cache` package (L2) + 24 tests, 100% cov
- [x] Message reordering (static-first, dynamic-last)
- [x] CacheHints generation via side-channel (moved to `@koi/execution-context`)
- [x] Provider-aware branching (Anthropic, OpenAI, unknown)

## Phase 3: Circuit Breaker Middleware (DONE)

- [x] Created `@koi/middleware-circuit-breaker` package (L2) + 13 tests
- [x] Per-provider breaker map, fallback model, half-open race protection

## Phase 4: Concurrent Observe Middleware (DONE)

- [x] `concurrent?: boolean` on `KoiMiddleware` (L0)
- [x] Race pattern in engine-compose (L1) + 6 tests, 149 existing pass

## Phase 5: Per-Agent Token Budgets (DONE)

- [x] `AgentBudgetTracker` in `@koi/middleware-pay` + 23 tests, 100% cov
- [x] Integrated into `createPayMiddleware` with 3 integration tests

## Integration (DONE)

- [x] `PROMPT_CACHE_HINTS` + `CacheHints` moved to `@koi/execution-context` (L0u shared)
- [x] Anthropic adapter in `@koi/model-router` reads hints → sets `cache_control` + 3 tests
- [x] `AgentBudgetTracker` wired into pay middleware call paths + session cleanup
- [x] `@koi/starter` registers "prompt-cache" and "circuit-breaker" in builtin registry

## Final test summary: 224 new tests + 149 existing = 373 total, 0 failures
