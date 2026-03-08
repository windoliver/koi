# Issue #902: @koi/temporal — Durable Agent Execution via Temporal

## Decisions Log

| # | Area | Issue | Decision |
|---|------|-------|----------|
| 1 | Arch | Runtime boundary | **1B**: Experimental Bun (embedded same-process) |
| 2 | Arch | Streaming | **2A**: Gateway WebSocket side channel |
| 3 | Arch | Optionality | **3A**: Fully optional L3 package |
| 4 | Arch | Migration | **4A**: Keep existing packages, add Temporal as alternative backend |
| 5 | Code | Activity design | **5C**: Single `runAgentTurn` Activity for v1 |
| 6 | Code | Error mapping | **6A**: Explicit `temporal-errors.ts` mapping module |
| 7 | Code | CAN draining | **7B**: `continueAsNewSuggested` + drain + `allHandlersFinished` |
| 8 | Code | Degradation | **8C**: Health check + circuit breaker |
| 9 | Test | Bun gate | **9A**: CI gate test (first test written) |
| 10 | Test | Replay tests | **10A**: Recorded history replay fixtures |
| 11 | Test | CI infra | **11C**: Split unit (TestWorkflowEnvironment) / integration (dev server, gated) |
| 12 | Test | Contract tests | **12A**: Reuse L0 contract test suites |
| 13 | Perf | Engine cache | **13A**: Cache `createKoi()` across turns (invalidate on manifest hash + forge generation) |
| 14 | Perf | Idle memory | **14A**: Benchmark + `maxCachedWorkflows` tuning |
| 15 | Perf | Dev resources | **15A**: Lazy start + docs + `koi doctor` |
| 16 | Perf | CAN state | **16A**: External state refs only (<1KB payload) |

---

## Architecture Summary

```
koi serve (Bun process, embedded Temporal Worker)
┌──────────────────────────────────────────────────────────┐
│  @temporalio/worker  (embedded, same Bun process)        │
│  ┌────────────────────────┐  ┌────────────────────────┐  │
│  │ Entity Workflow (agent) │  │ Entity Workflow (agent) │  │
│  │ signal → condition      │  │ signal → condition      │  │
│  │   → executeActivity     │  │   → executeActivity     │  │
│  └──────────┬──────────────┘  └──────────┬──────────────┘  │
│             │                             │                │
│  ┌──────────▼─────────────────────────────▼─────────────┐  │
│  │  Activity: runAgentTurn (in-process)                  │  │
│  │  cached createKoi() → runtime.run() → engine loop    │  │
│  │  text_delta → gateway.send(frame) → user             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  @temporalio/client  (signals, queries, start workflows)   │
│  Channel Layer  (gateway WebSocket, cli, slack, discord)   │
│  Nexus Client  (SSE → Temporal signal bridge)              │
│  Health Monitor  (circuit breaker for Temporal server)     │
│                                                            │
│  Temporal Server  (embedded dev or external prod)          │
│  localhost:7233                                             │
└──────────────────────────────────────────────────────────┘
```

**Key properties:**
- Temporal is OPTIONAL — only activated when `manifest.temporal` is configured
- Existing scheduler/harness packages UNCHANGED
- @koi/temporal implements L0 contracts (SpawnLedger, TaskScheduler, SessionPersistence)
- Workflow state is lightweight refs only — memory/conversation/forge in external stores
- Engine cached across turns (invalidated on manifest hash + forge generation change)
- Streaming via Gateway WebSocket (future-proof for hybrid Node.js if needed)
- Health monitor with circuit breaker for Temporal server connectivity

---

## Phase 1: Package Setup + Bun Compatibility Gate

### 1.1 Create `packages/exec/temporal/` package skeleton
- [ ] `package.json` — name: `@koi/temporal`, L3 deps: `@koi/core`, `@koi/engine`, `@koi/errors`, `@koi/gateway-types`, `@koi/health`, `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`, `@temporalio/common`
- [ ] `tsconfig.json` — extends root, strict
- [ ] `tsup.config.ts` — ESM-only, `.d.ts`
- [ ] `bunfig.toml` — test config
- [ ] Add `@koi/temporal` to `L3_PACKAGES` in `scripts/layers.ts`

### 1.2 Bun compatibility gate test (Decision 9A — FIRST test written)
- [ ] `src/__tests__/bun-compat.gate.test.ts`:
  - Create `NativeConnection` to localhost:7233
  - Create `Worker` with trivial no-op workflow
  - Execute workflow, verify completion
  - If fails: skip all other Temporal tests with "Bun incompatible" error
  - Gated behind `TEMPORAL_INTEGRATION=true` env var
- [ ] CI config: add `bun-compat` job that runs this test on every Bun version bump

### 1.3 Verify
- [ ] `bun install` succeeds (no dependency conflicts)
- [ ] `bun run build --filter=@koi/temporal` succeeds (empty package compiles)
- [ ] Layer check: `bun scripts/check-layers.ts` passes with new L3 entry

---

## Phase 2: Core Temporal Abstractions (Tests First)

### 2.1 Error mapping — `temporal-errors.ts` (Decision 6A)
- [ ] Test: `src/temporal-errors.test.ts`
  - `mapKoiErrorToApplicationFailure`: KoiError.retryable=true → nonRetryable=false
  - `mapKoiErrorToApplicationFailure`: KoiError.retryable=false → nonRetryable=true
  - `mapKoiErrorToApplicationFailure`: preserves error code, message, context
  - `mapTemporalError`: TimeoutFailure → KoiError { code: "TIMEOUT", retryable: true }
  - `mapTemporalError`: CancelledFailure → KoiError { code: "CANCELLED", retryable: false }
  - `mapTemporalError`: ApplicationFailure with KoiError payload → round-trips correctly
  - `mapTemporalError`: unknown error → KoiError { code: "INTERNAL", retryable: false }
- [ ] Impl: `src/temporal-errors.ts` (~60 lines)

### 2.2 Health monitor + circuit breaker — `temporal-health.ts` (Decision 8C)
- [ ] Test: `src/temporal-health.test.ts`
  - Healthy → polls Temporal server health endpoint
  - Unhealthy after N consecutive failures → circuit trips, emits degradation event
  - Recovery → circuit resets after successful health check
  - Metrics: latency, failure count, circuit state
  - Dispose: stops polling cleanly
- [ ] Impl: `src/temporal-health.ts` (~120 lines)
  - Implements `HealthMonitor` contract from `@koi/core`
  - Configurable poll interval (default: 10s), failure threshold (default: 3)
  - Emits `HealthStatus` events via callback

### 2.3 Engine cache — `engine-cache.ts` (Decision 13A)
- [ ] Test: `src/engine-cache.test.ts`
  - First call creates engine via `createKoi()`
  - Subsequent calls return cached instance
  - Cache invalidated when manifest hash changes
  - Cache invalidated when forge generation increments
  - Dispose: cleans up cached engine
- [ ] Impl: `src/engine-cache.ts` (~80 lines)
  - Cache key: `hash(manifest) + forgeGeneration`
  - Holds single `KoiRuntime` instance
  - `getOrCreate(manifest, adapter, options): Promise<KoiRuntime>`
  - `invalidate(): void`

### 2.4 Temporal embed mode — `temporal-embed.ts` (Decision 15A)
- [ ] Test: `src/temporal-embed.test.ts`
  - Auto-starts `temporal server start-dev` if not running
  - Detects existing server on port (health check)
  - Returns `{ url, dispose }` — dispose kills subprocess
  - PID tracked in `~/.koi/temporal-embed.pid`
  - Fails with clear error if `temporal` binary not found
  - Respects `--db-filename` for persistent storage
- [ ] Impl: `src/temporal-embed.ts` (~100 lines)
  - Same pattern as Nexus embed mode (#898)
  - `ensureTemporalRunning(config?: { port?: number; dbPath?: string })`
  - Poll until ready (max 5s timeout)

---

## Phase 3: Workflow + Activity Definitions (Tests First)

### 3.1 Agent Activity — `agent-activity.ts` (Decisions 5C, 13A, 2A)
- [ ] Test: `src/agent-activity.test.ts`
  - Executes `runtime.run()` via cached engine
  - Streams `text_delta` events to gateway WebSocket
  - Returns `AgentTurnResult` with content blocks + state refs
  - On error: maps to ApplicationFailure via `temporal-errors.ts`
  - Heartbeat: reports progress during long turns
- [ ] Impl: `src/agent-activity.ts` (~80 lines)
  - `runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult>`
  - Uses cached engine from `engine-cache.ts`
  - Streams via gateway frame sender (closure from Worker context)
  - Returns lightweight result (content blocks + external state refs per 16A)

### 3.2 Entity Workflow — `agent-workflow.ts` (Decisions 7B, 16A)
- [ ] Test: `src/agent-workflow.test.ts` (uses TestWorkflowEnvironment per 11C)
  - Signal: message → pendingMessages grows → Activity executes
  - Query: memoryQuery → returns current state refs
  - Query: statusQuery → returns "idle" | "working"
  - Idle: suspends via `condition()` → zero CPU
  - CAN: triggers on `continueAsNewSuggested`, drains signals, awaits `allHandlersFinished`
  - CAN payload: only lightweight refs (<1KB)
- [ ] Impl: `src/agent-workflow.ts` (~120 lines)
  - Entity Workflow pattern: signal handlers + query handlers + Activity dispatch
  - `agentWorkflow(config: AgentWorkflowConfig): Promise<void>`
  - State: `{ agentId, sessionId, lastTurnId, pendingMessages[] }` (all refs, no data)

### 3.3 Child Workflow — `child-workflow.ts`
- [ ] Test: `src/child-workflow.test.ts`
  - Worker agent spawned as child workflow
  - Parent controls lifecycle (TERMINATE policy for workers)
  - Returns result to parent via workflow return value
  - Inherits scope-filtered components via InheritedComponentProvider (unchanged)
- [ ] Impl: `src/child-workflow.ts` (~60 lines)
  - `workerWorkflow(config: WorkerWorkflowConfig): Promise<AgentTurnResult>`
  - Single-task scope: execute → return → terminate

### 3.4 Determinism replay tests (Decision 10A)
- [ ] `src/__tests__/replay.test.ts`
  - Record event histories from known-good workflow runs
  - Store as JSON fixtures in `src/__tests__/fixtures/`
  - Replay against current workflow code
  - Verify same state at each checkpoint
  - Run with TestWorkflowEnvironment (time-skipping)

---

## Phase 4: L0 Contract Implementations (Tests First)

### 4.1 Temporal SpawnLedger — `temporal-spawn-ledger.ts`
- [ ] Test: reuse `@koi/test-utils-store-contracts` SpawnLedger contract suite (Decision 12A)
- [ ] Test: Temporal-specific: ledger state survives workflow CAN
- [ ] Impl: `src/temporal-spawn-ledger.ts` (~50 lines)
  - Implements `SpawnLedger` from `@koi/core`
  - Backed by workflow state (child workflow count)
  - `acquire()` / `release()` / `activeCount()` / `capacity()`

### 4.2 Temporal Scheduler — `temporal-scheduler.ts`
- [ ] Test: reuse `@koi/test-utils-store-contracts` TaskScheduler contract suite (Decision 12A)
- [ ] Test: Temporal-specific: cron definition → Temporal Schedule creation
- [ ] Impl: `src/temporal-scheduler.ts` (~100 lines)
  - Bridge `@koi/scheduler` cron definitions to Temporal Schedules
  - `createTemporalScheduler(client: TemporalClient): TaskScheduler`

### 4.3 Verify contract compliance
- [ ] All SpawnLedger contract tests pass with Temporal backend
- [ ] All TaskScheduler contract tests pass with Temporal backend

---

## Phase 5: CLI Wiring + Integration

### 5.1 Wire into `koi serve` (`serve.ts`)
- [ ] Detect `manifest.temporal` config section
- [ ] If present: auto-start Temporal (embed mode per 15A)
- [ ] Create Temporal Worker with workflow + activity registrations
- [ ] Create Entity Workflow per copilot agent
- [ ] Bridge Nexus IPC → Temporal signals (mailbox.onMessage → signal)
- [ ] Register `temporal.dispose()` on shutdown hook
- [ ] Start health monitor (Decision 8C)

### 5.2 `koi doctor` command
- [ ] Add `koi doctor` subcommand
- [ ] Check: Bun version + Temporal SDK compatibility
- [ ] Check: Temporal server reachable (if configured)
- [ ] Check: Nexus server reachable (if configured)
- [ ] Check: available memory vs estimated requirements
- [ ] Report: resource usage summary

### 5.3 Manifest schema extension
- [ ] Add optional `temporal:` section to `AgentManifest` schema:
  ```yaml
  temporal:
    url: "localhost:7233"        # optional, defaults to embed mode
    taskQueue: "koi-agents"      # optional, defaults to "koi-default"
    maxCachedWorkflows: 100      # optional, tuning per 14A
  ```
- [ ] Validate at startup (fail-fast if malformed)

---

## Phase 6: Integration Tests (Gated)

### 6.1 Unit tests (TestWorkflowEnvironment, runs on every PR)
- [ ] Entity Workflow signal/query handlers
- [ ] CAN with signal draining (time-skipping)
- [ ] Error mapping round-trip
- [ ] Health monitor circuit breaker
- [ ] Engine cache invalidation

### 6.2 Integration tests (TEMPORAL_INTEGRATION=true, nightly CI)
- [ ] Embed mode auto-starts Temporal server
- [ ] Nexus IPC message → Temporal signal → workflow wakes
- [ ] forge_agent → child workflow spawn with inherited components
- [ ] Crash recovery: kill worker mid-activity, verify replay from last turn
- [ ] Collective memory middleware works inside Activity
- [ ] Idle workflow memory benchmark (Decision 14A)

### 6.3 E2E tests (TEMPORAL_E2E=true, weekly CI)
- [ ] Copilot conversation through Entity Workflow + context-arena
- [ ] Copilot spawns worker via forge_agent → child workflow → result returned
- [ ] Temporal Schedule fires → agent processes scheduled task

---

## Phase 7: Documentation + Anti-Leak Verification

### 7.1 Anti-leak checklist
- [ ] `@koi/core` has zero imports from `@temporalio/*`
- [ ] No Temporal types in any L0 or L1 file
- [ ] `@koi/temporal` imports only from L0, L0u, and L1 (valid for L3)
- [ ] All `@temporalio/*` imports confined to `packages/exec/temporal/`
- [ ] Entity Workflow exposes zero Temporal-specific concepts in public API
- [ ] Forge system has zero awareness of Temporal

### 7.2 Documentation
- [ ] README.md in `packages/exec/temporal/`
- [ ] Add `@koi/temporal` to architecture doc layer diagram
- [ ] Resource requirements doc (memory, process count)
- [ ] `koi doctor` output includes Temporal status

---

## File Manifest

```
packages/exec/temporal/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── bunfig.toml
└── src/
    ├── index.ts                      # Public exports (L0 types only, no Temporal leaks)
    ├── temporal-errors.ts            # KoiError ↔ Temporal error mapping (Decision 6A)
    ├── temporal-errors.test.ts
    ├── temporal-health.ts            # Health monitor + circuit breaker (Decision 8C)
    ├── temporal-health.test.ts
    ├── temporal-embed.ts             # Auto-start dev server (Decision 15A)
    ├── temporal-embed.test.ts
    ├── engine-cache.ts               # Cached createKoi() across turns (Decision 13A)
    ├── engine-cache.test.ts
    ├── agent-workflow.ts             # Entity Workflow definition (Decisions 7B, 16A)
    ├── agent-workflow.test.ts
    ├── agent-activity.ts             # Activity wrapping runtime.run() (Decisions 5C, 2A)
    ├── agent-activity.test.ts
    ├── child-workflow.ts             # Child workflow for workers
    ├── child-workflow.test.ts
    ├── temporal-spawn-ledger.ts      # SpawnLedger L0 contract impl (Decision 12A)
    ├── temporal-spawn-ledger.test.ts
    ├── temporal-scheduler.ts         # TaskScheduler L0 contract impl (Decision 12A)
    ├── temporal-scheduler.test.ts
    ├── types.ts                      # Internal types (AgentWorkflowConfig, AgentTurnInput, etc.)
    └── __tests__/
        ├── bun-compat.gate.test.ts   # Bun compatibility gate (Decision 9A)
        ├── replay.test.ts            # Determinism replay tests (Decision 10A)
        ├── fixtures/                 # Recorded event histories for replay
        ├── integration.test.ts       # Gated integration tests (Decision 11C)
        └── e2e.test.ts               # Gated E2E tests
```

**Estimated LOC:** ~700-900 implementation + ~600-800 tests = ~1,300-1,700 total

---

## PR Strategy

| PR | Scope | Est. Lines | Depends On |
|----|-------|-----------|------------|
| PR 1 | Package skeleton + Bun compat gate + layers.ts update | ~100 | — |
| PR 2 | Core abstractions (errors, health, cache, embed) | ~300 | PR 1 |
| PR 3 | Workflow + Activity definitions + replay tests | ~350 | PR 2 |
| PR 4 | L0 contract implementations (SpawnLedger, Scheduler) | ~200 | PR 3 |
| PR 5 | CLI wiring (serve.ts, doctor, manifest schema) | ~250 | PR 4 |
| PR 6 | Integration + E2E tests | ~300 | PR 5 |

Each PR < 350 lines of logic. Total: ~1,500 lines across 6 PRs.

---

## Review Notes

- Every phase follows TDD: tests first, then implementation
- Layer violations caught by `check-layers.ts` — verify after each PR
- Temporal SDK version pinned exact (`exact = true` in bunfig.toml)
- All @temporalio/* packages MUST be same version (peer dep enforcement)
- Bun compat gate test blocks all other Temporal tests if it fails
- Integration tests gated behind env vars, run in nightly CI only
