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

---

# Issues #273, #288, #77, #100, #102 — CI Governance Improvements

## Decisions Log

| # | Area | Issue | Decision | Choice |
|---|------|-------|----------|--------|
| 1 | Arch | #273 | L0u whitelist single source of truth | **1A**: Generate docs from `layers.ts` (generator + CI doc-sync check) |
| 2 | Arch | #288 | Pace-layered CI enforcement | **2A**: Split `ci-L0.yml`, `ci-L1.yml`, `ci-L2.yml` + paths filters + CODEOWNERS |
| 3 | Arch | #288 | L0u PR labeling | **3B**: Generator also writes `labeler.yml` L0u entries |
| 4 | Arch | #102 | L0 interfaces-only enforcement | **4A**: Add L0 structure scan to `check-layers.ts` |
| 5 | Code | #77 | L0u source file scan | **5A**: Add `isL0uViolation` predicate + source scan |
| 6 | Code | — | Multiline type import gap | **6A**: Fix regex + add regression test |
| 7 | Code | — | `layer:L2` double-labeling | **7B**: Generator handles labeler.yml L0u globs precisely |
| 8 | Code | — | Immutability: `Array.push` in `main()` | **8A**: Spread accumulation instead of push |
| 9 | Test | — | TDD discipline | **9A**: Strict TDD — tests first, then implementation |
| 10 | Test | — | `scanFilesForViolations` integration test | **10A**: Temp-dir integration test |
| 11 | Test | — | `isTestFile` tests | **11A**: Export + 8 unit tests |
| 12 | Test | — | Generator tests | **12B**: CI doc-sync check IS the test |
| 13 | Perf | — | `Bun.Transpiler` singleton | **13A**: Hoist to module-level `const TRANSPILER` |
| 14 | Perf | — | Parallel source scans | **14B**: `Promise.all` on scan calls, keep two loops |
| 15 | Perf | #288 | L2 CI build+test scope | **15A**: `turbo run --filter='...[origin/main]'` in ci-L2.yml |
| 16 | Perf | — | check-layers on doc-only PRs | **16B**: Always run, it's fast |

---

## PR A: Fix and harden `check-layers.ts` (Issues #273, #77, #102)

### Phase A1: Tests first (per decision 9A)
- [ ] Export `isTestFile` from `check-layers.ts`
- [ ] Add `isTestFile` unit tests: 4 true cases + 4 false cases (decision 11A)
- [ ] Add `isL0uViolation` unit tests (decision 5A):
  - `@koi/engine` → true
  - L2 package (`@koi/gateway`) → true
  - `@koi/core` → false
  - `@koi/errors` (L0u peer) → false
  - relative `./utils.js` → false
- [ ] Add multiline type import regression test to `extractImportSpecifiers` tests (decision 6A):
  - `import type {\n  Foo,\n  Bar\n} from "@koi/engine"` → catches `@koi/engine`
- [ ] Add L0 structure scan unit tests (decision 4A):
  - `export interface Foo { readonly x: string }` → no violation
  - `export type Bar = string` → no violation
  - `export function foo() {}` → violation
  - `export class Baz {}` → violation
  - Exception: `export function isKoiError` (type guard) → no violation (permitted exception list)
- [ ] Add temp-dir integration test for `scanFilesForViolations` (decision 10A):
  - Create temp dir, write fake `.ts` with violation, assert function returns it
  - Create temp dir with `.test.ts` violation, assert it's skipped

### Phase A2: Implementation
- [ ] Hoist `new Bun.Transpiler({ loader: "ts" })` to `const TRANSPILER = ...` at module scope (decision 13A)
- [ ] Fix `extractImportSpecifiers` regex to handle multiline type imports (decision 6A)
- [ ] Export `isTestFile` (decision 11A)
- [ ] Add `isL0uViolation(specifier)` predicate (decision 5A):
  - True if `specifier` is `@koi/engine` or starts with `@koi/engine/`
  - True if `specifier` starts with `@koi/` and is not L0 or L0u
- [ ] Add L0u source scan in `main()` — call `scanFilesForViolations` for each L0u package src dir (decision 5A)
- [ ] Add L0 structure scan in `main()` — scan `@koi/core/src` for function/class declarations (decision 4A)
- [ ] Fix `Array.push()` mutation in `main()`: replace with `const violations = [...a, ...b, ...c]` spread (decision 8A)
- [ ] Parallelize L0u + L2 source scans with `Promise.all` (decision 14B)

### Phase A3: Verify
- [ ] `bun test packages/scripts/` (or wherever check-layers.test.ts lives) — all pass
- [ ] `bun scripts/check-layers.ts` — passes on current codebase (no false positives)

---

## PR B: Generator — `layers.ts` → docs + `labeler.yml` (Issues #273, #288)

### Phase B1: Tests first (per decision 9A)
- [ ] No unit tests for generator (decision 12B — CI doc-sync check IS the test)

### Phase B2: Implementation
- [ ] Write `scripts/generate-layer-docs.ts`:
  - Reads `L0U_PACKAGES` from `layers.ts`
  - Outputs markdown table of L0u packages for insertion into `docs/architecture/Koi.md`
  - Outputs `labeler.yml` L0u glob entries (strips `@koi/` prefix, maps to `packages/<name>/**`) (decision 3B)
  - Also outputs L3 entries using `L3_PACKAGES`
- [ ] Write `scripts/check-doc-sync.ts`:
  - Runs the generator in memory, compares output vs current file contents
  - Exits with code 1 + diff if stale (decision 12B = this IS the test)
- [ ] Update `docs/architecture/Koi.md`: add `@koi/acp-protocol` to L0u section (the one missing package)
- [ ] Regenerate `labeler.yml` from generator:
  - Add explicit `layer:L0u` label section with 24 package globs
  - Tighten `layer:L2` catch-all to exclude L0/L1/L0u/L3 paths (decision 7B)
- [ ] Update CLAUDE.md: expand L0u list from 16 to 24 (one-time sync)
- [ ] Add `check:doc-sync` script to root `package.json`

### Phase B3: Verify
- [ ] `bun scripts/check-doc-sync.ts` — exits 0 on freshly generated docs
- [ ] `bun scripts/check-doc-sync.ts` after manually mutating Koi.md — exits 1 (enforcement works)

---

## PR C: Pace-layered CI workflows (Issue #288)

### Phase C1: CODEOWNERS
- [ ] Create `CODEOWNERS` file at repo root:
  - `packages/core/` → (assign 2 owners for 2-reviewer gate on L0)
  - `packages/engine/` → (assign 1+ owners)
  - `scripts/layers.ts` → (same L0-level owners — source of truth)

### Phase C2: Split CI workflows
- [ ] Extract reusable setup into `.github/workflows/setup.yml` (checkout + bun + cache steps):
  - `actions/checkout@v4`
  - `oven-sh/setup-bun@v2`
  - Bun dep cache
  - Turborepo cache
  - `bun install --frozen-lockfile`
- [ ] Create `.github/workflows/ci-L0.yml`:
  - Triggers: `paths: [packages/core/**, scripts/layers.ts, scripts/check-layers.ts]`
  - Jobs: lint, check:layers, **check:doc-sync** (new), full build, full typecheck, full test
  - Requires 2 reviewers (enforced via CODEOWNERS, not workflow)
- [ ] Create `.github/workflows/ci-L1.yml`:
  - Triggers: `paths: [packages/engine/**]`
  - Jobs: lint, check:layers, build (turbo filter L0+L1), typecheck (turbo filter), test (turbo filter)
- [ ] Create `.github/workflows/ci-L2.yml`:
  - Triggers: `paths: [packages/**, !packages/core/**, !packages/engine/**]`
  - Jobs: lint, check:layers, affected build+test: `turbo run build test --filter='...[origin/main]'` (decision 15A)
  - Requires `git fetch origin main --depth=0` before Turborepo filter step
- [ ] Update `.github/workflows/ci.yml`:
  - Keep as catch-all for non-package changes (CI config, docs, scripts outside layers)
  - Or repurpose as the L0-level full-suite workflow

### Phase C3: Verify
- [ ] Open a test PR touching only `packages/core/` — confirm `ci-L0.yml` triggers, others don't
- [ ] Open a test PR touching only `packages/<L2-package>/` — confirm `ci-L2.yml` triggers, uses `--filter`
- [ ] Verify `check:doc-sync` step fails if layers.ts and docs are out of sync

---

## Review Notes (CI Governance)
- Every implementation step follows TDD: tests written before code (decision 9A)
- No changes to `layers.ts` content — it is the source of truth, only docs/labeler change to match it
- PR order: A → B → C (each PR unblocks the next)
- PR A is self-contained; PR B depends on PR A passing; PR C depends on PR B labeler output
