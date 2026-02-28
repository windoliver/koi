# Issues #510 & #521 Implementation Plan

## Decisions Log

| # | Area | Decision | Choice |
|---|------|----------|--------|
| 1 | Arch | `request_permission` routing | **1A**: Approval bridge via `wrapToolCall` (mirror engine-claude) |
| 2 | Arch | ACP transport abstraction | **2A**: Thin `AcpTransport` interface (send/receive/close) |
| 3 | Arch | ACP spec churn isolation | **3A**: Zod schemas in `acp-schema.ts` at transport boundary |
| 4 | Arch | Split ordering | **4A**: Ralph rename → forge → engine → test-utils |
| 5 | Code | forge shared types | **5A**: New `@koi/forge-types` L0u package |
| 6 | Code | Async queue for ACP | **6A**: Copy `async-queue.ts` from engine-external |
| 7 | Code | ACP session state | **7C**: No `saveState`/`loadState` for v1 (stateless) |
| 8 | Code | test-utils backwards compat | **8A**: Transitional barrel re-export in `@koi/test-utils` |
| 9 | Test | engine-acp contract tests | **9A+B**: Mock transport (unit) + fixture script (e2e) |
| 10 | Test | Error path coverage | **10A**: Explicit tests for all 4 JSON-RPC error paths |
| 11 | Test | API surface snapshots | **11A**: Write first, before code, for each sub-package |
| 12 | Test | fs/* and terminal/* tests | **12A**: Round-trip tests via mock transport |
| 13 | Perf | stdin/stdout framing | **13A**: Adapt line-parser + JSON-RPC router from engine-external |
| 14 | Perf | Process lifecycle | **14A**: Long-lived only (spawn+init once, session per stream()) |
| 15 | Perf | forge-types scope | **15A**: Curate to stable contract types only |
| 16 | Perf | Async queue memory | **16A**: Unbounded + high-watermark warning at 500 items |

---

## PR 1: `@koi/ralph` → `@koi/verified-loop` rename (#510)

- [ ] `git mv packages/ralph packages/verified-loop`
- [ ] Update `package.json` name field: `@koi/ralph` → `@koi/verified-loop`
- [ ] Update JSDoc comments in `index.ts`, `types.ts`, `ralph-loop.ts`
- [ ] Rename `ralph-loop.ts` → `verified-loop.ts`, `ralph-loop.test.ts` → `verified-loop.test.ts`
- [ ] Update `createRalphLoop` → `createVerifiedLoop`, `RalphConfig` → `VerifiedLoopConfig`, `RalphLoop` → `VerifiedLoop`, `RalphResult` → `VerifiedLoopResult`
- [ ] Update `index.ts` re-exports
- [ ] Run `bun install` to update lockfile
- [ ] Run `bun test --cwd packages/verified-loop` to verify
- [ ] Verify build passes

---

## PR 2: `@koi/engine-acp` — new L2 engine adapter (#521)

### Package setup
- [ ] Create `packages/engine-acp/` with `package.json`, `tsconfig.json`, `tsup.config.ts`
- [ ] Dependencies: `@koi/core`, `@koi/errors`, `zod`

### Core files
- [ ] `src/acp-schema.ts` — Zod schemas for all ACP wire types (initialize, session/*, fs/*, terminal/*)
- [ ] `src/transport.ts` — `AcpTransport` interface + `createStdioTransport(process)` implementation
- [ ] `src/json-rpc-parser.ts` — Line-buffer framing + `routeMessage()` for id/notification/callback routing
- [ ] `src/async-queue.ts` — Copy from engine-external + add high-watermark warning (500 items default)
- [ ] `src/approval-bridge.ts` — Map `session/request_permission` to `wrapToolCall` synthetic tool calls
- [ ] `src/event-map.ts` — Map ACP `session/update` notifications to Koi `EngineEvent` discriminated union
- [ ] `src/fs-handlers.ts` — Default handlers for `fs/read_text_file`, `fs/write_text_file`
- [ ] `src/terminal-handlers.ts` — Default handlers for `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`
- [ ] `src/adapter.ts` — `createAcpAdapter(config)` factory: long-lived process, new session per `stream()`, approval bridge wired
- [ ] `src/types.ts` — `AcpAdapterConfig`, `AcpCapabilities` internal types
- [ ] `src/descriptor.ts` — `describeCapabilities()` for API surface
- [ ] `src/index.ts` — Public exports

### Tests (written first per 9A+B, 10A, 12A decisions)
- [ ] `src/acp-schema.test.ts` — Zod schema validation (happy + rejection cases)
- [ ] `src/json-rpc-parser.test.ts` — Line framing, message routing
- [ ] `src/async-queue.test.ts` — Queue behavior + watermark warning
- [ ] `src/approval-bridge.test.ts` — Approval routing through wrapToolCall
- [ ] `src/event-map.test.ts` — session/update → EngineEvent mapping
- [ ] `src/adapter.test.ts` — Unit tests with mock transport (all 4 error paths per 10A, round-trip fs/* per 12A)
- [ ] `src/__tests__/e2e.test.ts` — Contract suite via `testEngineAdapter` + fixture ACP script
- [ ] `src/__tests__/fixture-agent.ts` — Minimal ACP fixture agent (stdin/stdout)

---

## PR 3: forge split (#510)

### @koi/forge-types (L0u, curated stable types per 15A)
- [ ] Create `packages/forge-types/` package
- [ ] Move to forge-types: `ForgeResult`, `ForgeResultMetadata`, `VerificationReport`, `StageReport`, `ResolveStageReport`, `TrustStageReport`, `VerificationStage`, `ToolArtifact`, `SkillArtifact`, `AgentArtifact`, `ForgeInput`, `ForgeToolInput`
- [ ] Write `api-surface.test.ts` snapshot first (per 11A)

### @koi/forge-verify (static, format, resolve, sandbox, self_test, trust verification)
- [ ] Create `packages/forge-verify/` package
- [ ] Move: `verify.ts`, `verify-static.ts`, `verify-format.ts`, `verify-resolve.ts`, `verify-sandbox.ts`, `verify-self-test.ts`, `verify-trust.ts`, `verify-install-integrity.ts`, `adversarial-verifiers.ts`, `forge-diagnostic-verifier.ts`
- [ ] Internal types (ForgeContext, SandboxExecutor, ForgeVerifier) stay here
- [ ] Write `api-surface.test.ts` snapshot first

### @koi/forge-attestation
- [ ] Create `packages/forge-attestation/` package
- [ ] Move: `attestation.ts`, `attestation-cache.ts`, `slsa-serializer.ts`, `reverification.ts`, `reverification-queue.ts`, `integrity.ts`
- [ ] Write `api-surface.test.ts` snapshot first

### @koi/forge-workspace
- [ ] Create `packages/forge-workspace/` package
- [ ] Move: `workspace-manager.ts`, `workspace-scan.ts`, `brick-resolver.ts`, `brick-module-compiler.ts`, `brick-conversion.ts`, `brick-content.ts`, `dependency-audit.ts`, `assemble-manifest.ts`
- [ ] Write `api-surface.test.ts` snapshot first

### @koi/forge-tools
- [ ] Create `packages/forge-tools/` package
- [ ] Move: `tools/` directory (forge-tool, forge-skill, forge-agent, forge-middleware, forge-channel, forge-edit, compose-forge, promote-forge, search-forge, shared)
- [ ] Write `api-surface.test.ts` snapshot first

### @koi/forge (reduced — orchestration + component provider + config)
- [ ] Keep: `forge-runtime.ts`, `forge-component-provider.ts`, `forge-resolver.ts`, `forge-governance-contributor.ts`, `forge-usage-middleware.ts`, `config.ts`, `governance.ts`, `errors.ts`, `memory-store.ts`, `store-notifier.ts`, `scope-filter.ts`, `usage.ts`, `forge-defaults.ts`, `requires-check.ts`, `generate-skill-md.ts`
- [ ] Update imports to use sub-packages
- [ ] Keep re-exporting from sub-packages for backwards compat (transitional)
- [ ] Update `api-surface.test.ts`

---

## PR 4: engine split (#510) — after forge split complete

### @koi/engine-compose
- [ ] Move: `compose.ts`, `extension-composer.ts`
- [ ] Write `api-surface.test.ts` first

### @koi/engine-reconcile
- [ ] Move: `reconcile-runner.ts`, `supervision-reconciler.ts`, `guards.ts`, `timeout-reconciler.ts`, `tool-reconciler.ts`, `spawn-child.ts`, `spawn-ledger.ts`, `process-accounter.ts`, `backoff.ts`, `eviction-policies.ts`, `restart-intensity.ts`, `rolling-window.ts`, `cascading-termination.ts`, `health-monitor.ts`, `health-reconciler.ts`
- [ ] Write `api-surface.test.ts` first

### @koi/engine (kernel — reduced)
- [ ] Keep: `koi.ts`, `agent-entity.ts`, `lifecycle.ts`, `transitions.ts`, `governance-*.ts`, `registry.ts`, `types.ts`, `dispose.ts`, `child-handle.ts`, `inherited-component-provider.ts`, `clock.ts`, `is-promise.ts`, `result-pruner.ts`, `process-tree.ts`
- [ ] Update imports, keep re-export barrel for backwards compat
- [ ] Update `api-surface.test.ts`

---

## PR 5: test-utils split (#510) — after engine split complete

### @koi/test-utils-contracts
- [ ] Move: engine-contract, channel-contract, harness-contract, resolver-contract, middleware-contract
- [ ] Write `api-surface.test.ts` first

### @koi/test-utils-store-contracts
- [ ] Move: event-sourced-registry-contract, session-persistence-contract, skill-registry-contract, event-backend-contract, snapshot-chain-contract, store-contract, version-index-contract, brick-registry-contract
- [ ] Write `api-surface.test.ts` first

### @koi/test-utils-mocks
- [ ] Move: all mock factories (createMockAgent, createMockEngineAdapter, etc.), spy handlers, in-memory implementations, createTempGitRepo, captureOutput
- [ ] Write `api-surface.test.ts` first

### @koi/test-utils (transitional barrel per 8A)
- [ ] Update `index.ts` to re-export from all 3 sub-packages
- [ ] Add deprecation notices to re-exports
- [ ] Update `api-surface.test.ts`

---

## Review Notes
- Every PR must pass `bun run build && bun test` before merge
- PR size target: < 300 lines logic changes (split PRs are infrastructure, exempt from this)
- Layer violations caught by import-lint CI check — verify after each PR
