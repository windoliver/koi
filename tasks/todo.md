# Issue #247: Brick Dependency Management

Install, cache, audit, and hot-update npm dependencies for forged bricks.

## Decisions Log

| # | Area | Decision | Choice |
|---|------|----------|--------|
| 1 | Architecture | Where `dependencies` lives in L0 | **1B**: Extend `BrickRequires` with `packages?: Record<string, string>` |
| 2 | Architecture | Brick workspace location | **2A**: XDG cache dir `$XDG_CACHE_HOME/koi/brick-workspaces/<dep-hash>/` |
| 3 | Architecture | Pipeline stage for install | **3A**: New "resolve" stage between Static and Sandbox |
| 4 | Architecture | Promoted tier execution | **4A**: Direct `import()` + query-string cache busting |
| 5 | Code Quality | SandboxExecutor interface | **5A**: Optional `ExecutionContext` object parameter |
| 6 | Code Quality | DRY ForgeInput types | **6A**: Extract `ForgeInputBase` intersection type |
| 7 | Code Quality | Promoted executor cache | **7A**: LRU eviction, 256-entry cap |
| 8 | Code Quality | Dependency config | **8A**: New `DependencyConfig` section in `ForgeConfig` |
| 9 | Tests | brick-conversion tests | **9A**: TDD with colocated `brick-conversion.test.ts` |
| 10 | Tests | Workspace management tests | **10A**: Unit tests (mocked) + integration tests (real FS) |
| 11 | Tests | Promoted executor tests | **11A**: Comprehensive suite for import()-based executor |
| 12 | Tests | Dependency audit tests | **12A**: Dedicated adversarial test file |
| 13 | Performance | bun install latency | **13A**: Cache-first + configurable `installTimeoutMs` (15s), increase `totalTimeoutMs` to 60s |
| 14 | Performance | import() cold start | **14A**: Pre-write `.ts` file at forge time, not execution time |
| 15 | Performance | Workspace disk usage | **15A**: LRU eviction by access time (30d), max cache size (1GB) |
| 16 | Performance | Dep hash computation | **16A**: `sha256(JSON.stringify(Object.entries(deps).sort()))` via `@koi/hash` |

---

## Phase 1: L0 Type Changes (`@koi/core`)

Smallest blast radius — pure type changes that propagate errors downstream.

### 1.1 Extend `BrickRequires` with `packages` field
- [ ] `packages/core/src/brick-store.ts` — Add `readonly packages?: Readonly<Record<string, string>>` to `BrickRequires` (line 30-37)
- [ ] JSDoc: "npm package dependencies to install. Keys are package names, values are exact semver versions."

### 1.2 Add `ExecutionContext` type and update `SandboxExecutor`
- [ ] `packages/core/src/sandbox-executor.ts` — Add `ExecutionContext` interface:
  ```typescript
  export interface ExecutionContext {
    readonly workspacePath?: string;
  }
  ```
- [ ] `packages/core/src/sandbox-executor.ts` — Add optional 4th parameter to `SandboxExecutor.execute`:
  ```typescript
  execute(code: string, input: unknown, timeoutMs: number, context?: ExecutionContext) => ...
  ```
- [ ] Update API surface snapshot test

### 1.3 Verify L0 anti-leak
- [ ] `@koi/core` has zero `import` statements from other packages
- [ ] No function bodies or class definitions (only types/interfaces)
- [ ] All properties are `readonly`

---

## Phase 2: `ForgeInputBase` DRY Refactor (`@koi/forge`)

Extract repeated fields before adding new features.

- [ ] `packages/forge/src/types.ts` — Define `ForgeInputBase`:
  ```typescript
  interface ForgeInputBase {
    readonly name: string;
    readonly description: string;
    readonly tags?: readonly string[];
    readonly files?: Readonly<Record<string, string>>;
    readonly requires?: BrickRequires;
    readonly classification?: DataClassification;
    readonly contentMarkers?: readonly ContentMarker[];
  }
  ```
- [ ] Refactor all 6 `ForgeInput` variants to use `ForgeInputBase & { ... }`
- [ ] Verify `switch (input.kind)` discrimination still works
- [ ] Run existing tests — no regressions

---

## Phase 3: `DependencyConfig` in `ForgeConfig` (`@koi/forge`)

Add configuration for dependency management.

- [ ] `packages/forge/src/config.ts` — Add `DependencyConfig` interface:
  ```typescript
  interface DependencyConfig {
    readonly allowedPackages?: readonly string[];
    readonly blockedPackages?: readonly string[];
    readonly maxDependencies: number;
    readonly installTimeoutMs: number;
    readonly cacheDirOverride?: string;
    readonly maxCacheSizeBytes: number;
    readonly maxWorkspaceAgeDays: number;
  }
  ```
- [ ] Add `dependencies: DependencyConfig` to `ForgeConfig`
- [ ] Add defaults:
  ```typescript
  const DEFAULT_DEPENDENCY_CONFIG: DependencyConfig = {
    maxDependencies: 20,
    installTimeoutMs: 15_000,
    maxCacheSizeBytes: 1_073_741_824, // 1GB
    maxWorkspaceAgeDays: 30,
  };
  ```
- [ ] Add Zod schema for `DependencyConfig`
- [ ] Update `createDefaultForgeConfig` and `validateForgeConfig`
- [ ] Increase `totalTimeoutMs` default from 30s to 60s
- [ ] Update `config.test.ts` with new config fields

---

## Phase 4: Workspace Manager (`@koi/forge`)

New module for per-brick workspace lifecycle.

### 4.1 Create `workspace-manager.ts`
- [ ] Create `packages/forge/src/workspace-manager.ts`
- [ ] Implement:
  - `computeDependencyHash(packages: Record<string, string>): string` — sorted JSON entries → SHA-256 via `@koi/hash`
  - `resolveWorkspacePath(depHash: string, cacheDir?: string): string` — `$XDG_CACHE_HOME/koi/brick-workspaces/<depHash>/`
  - `createBrickWorkspace(packages: Record<string, string>, config: DependencyConfig): Promise<Result<WorkspaceResult, ForgeError>>`:
    1. Compute dep hash
    2. Check if workspace exists (cache hit → return path, update access time)
    3. Cache miss: create dir, write `package.json`, run `bun install --frozen-lockfile` with timeout
    4. Return `{ workspacePath, cacheHit, installDurationMs }`
  - `writeBrickEntry(workspacePath: string, implementation: string, brickName: string): Promise<string>` — writes `.ts` file, returns entry path
  - `cleanupStaleWorkspaces(config: DependencyConfig): Promise<number>` — LRU eviction by access time

### 4.2 Create `workspace-manager.test.ts` (unit tests, mocked I/O)
- [ ] Tests for `computeDependencyHash`:
  - Deterministic output (same deps → same hash)
  - Order-independent (different insertion order → same hash)
  - Different deps → different hash
  - Empty deps → consistent hash
- [ ] Tests for `resolveWorkspacePath`:
  - XDG_CACHE_HOME respected
  - Fallback to ~/.cache/koi
- [ ] Tests for `createBrickWorkspace`:
  - Cache hit (workspace exists) → returns immediately
  - Cache miss → creates dir + package.json
  - Install timeout → returns error
  - Invalid package names → returns validation error
- [ ] Tests for `writeBrickEntry`:
  - Writes valid .ts file
  - Returns correct path
- [ ] Tests for `cleanupStaleWorkspaces`:
  - Evicts workspaces older than maxWorkspaceAgeDays
  - Respects maxCacheSizeBytes
  - Doesn't evict recently-accessed workspaces

### 4.3 Create integration test (real FS, env-gated)
- [ ] `packages/forge/src/__tests__/workspace-integration.test.ts`
- [ ] Gate behind `WORKSPACE_INTEGRATION` env var
- [ ] Tests:
  - Real `bun install` with a single small dep (e.g., `is-odd`)
  - Workspace reuse on cache hit
  - Module resolution works from workspace
  - Cleanup removes stale dirs

---

## Phase 5: Dependency Audit Gate (`@koi/forge`)

Allowlist/denylist validation for brick dependencies.

### 5.1 Create `dependency-audit.ts`
- [ ] Create `packages/forge/src/dependency-audit.ts`
- [ ] Implement `auditDependencies(packages: Record<string, string>, config: DependencyConfig): Result<void, ForgeError>`:
  - Validate max dependency count
  - Check each package against `blockedPackages` (exact match + glob)
  - If `allowedPackages` set, check each package is in the allowlist
  - Validate package names (no path traversal, no scoped injection)
  - Validate version strings (exact semver only, no ranges/tags)
- [ ] Export audit function

### 5.2 Create `dependency-audit.test.ts` (adversarial)
- [ ] Create `packages/forge/src/dependency-audit.test.ts`
- [ ] Adversarial test cases:
  - Typosquats (`lodas` when `lodash` allowed but not `lodas`)
  - Scope injection (`@evil/lodash`)
  - Blocked package detection
  - Version range rejection (`^1.0.0`, `~1.0.0`, `*`, `latest`)
  - Path traversal in package name (`../../../etc/passwd`)
  - Max dependency count enforcement
  - Empty dependency map (should pass)
  - Allow/block overlap resolution
  - Unicode in package names

---

## Phase 6: Verify-Resolve Stage (`@koi/forge`)

New pipeline stage between Static and Sandbox.

### 6.1 Create `verify-resolve.ts`
- [ ] Create `packages/forge/src/verify-resolve.ts`
- [ ] Implement `verifyResolve(input: ForgeInput, config: ForgeConfig): Promise<Result<ResolveStageReport, ForgeError>>`:
  1. If `input.requires?.packages` is undefined or empty → pass-through (no-op stage)
  2. Run `auditDependencies()` — fail fast if audit fails
  3. Run `createBrickWorkspace()` — create/reuse workspace
  4. If brick has implementation → run `writeBrickEntry()` — pre-write .ts file
  5. Run lazy `cleanupStaleWorkspaces()` (non-blocking, best-effort)
  6. Return `ResolveStageReport` with `workspacePath`, `cacheHit`, `installDurationMs`
- [ ] Add `"resolve"` to `VerificationStage` union in `types.ts`
- [ ] Define `ResolveStageReport extends StageReport` with workspace metadata

### 6.2 Update `verify.ts` pipeline
- [ ] Insert resolve stage after Static, before Sandbox:
  ```
  Static → Resolve → Sandbox → Self-Test → Trust
  ```
- [ ] Pass `ResolveStageReport.workspacePath` to sandbox stage via `ExecutionContext`
- [ ] Add timeout check between Resolve and Sandbox

### 6.3 Create `verify-resolve.test.ts`
- [ ] Tests:
  - No packages → pass-through (no-op)
  - Valid packages → workspace created, stage passes
  - Blocked package → audit fails, stage fails
  - Workspace cache hit → no install, fast pass
  - Install timeout → stage fails with TIMEOUT error
  - Invalid version string → audit fails

### 6.4 Update `verify.test.ts`
- [ ] Update pipeline tests to include resolve stage
- [ ] Test 5-stage pipeline ordering
- [ ] Test timeout propagation through resolve stage

---

## Phase 7: Sandbox Executor Updates (`@koi/sandbox-executor`)

### 7.1 Update `promoted-executor.ts` for `import()`
- [ ] Replace `new Function("input", code)` with `import()` from workspace file
- [ ] Accept `ExecutionContext` parameter (workspace path)
- [ ] Implement query-string cache busting: `import(`${entryPath}?v=${contentHash}`)`
- [ ] Replace unbounded `Map` with LRU cache (256-entry cap)
- [ ] Fallback: if no workspace path, keep `new Function()` for backward compatibility
- [ ] Add timeout enforcement via `AbortController` + `Promise.race()`

### 7.2 Update `verify-sandbox.ts` to pass `ExecutionContext`
- [ ] Pass `context.workspacePath` from resolve stage to sandbox executor
- [ ] If no workspace, `context` is undefined (backward-compatible)

### 7.3 Update `brick-conversion.ts` for trust-tier dispatch
- [ ] Check `brick.trustTier`:
  - `"promoted"` → use `import()` from workspace (pass `ExecutionContext`)
  - `"sandbox"` / `"verified"` → use `executor.execute()` with workspace mount
- [ ] Accept optional `workspacePath` parameter in `brickToTool()`

### 7.4 Rewrite `promoted-executor.test.ts`
- [ ] `import()` happy path — module loaded and executed
- [ ] `import()` failure — file not found, syntax error
- [ ] LRU eviction at boundary (256 → 257 entries)
- [ ] Query-string cache busting — new content hash → fresh module
- [ ] Timeout enforcement — hang → TIMEOUT error
- [ ] Error classification — Permission, Crash
- [ ] Backward compat — no context → falls back to `new Function()`

### 7.5 Create `brick-conversion.test.ts` (TDD)
- [ ] Baseline: sandbox tier → executor.execute() (current behavior)
- [ ] New: promoted tier → import() path
- [ ] Error wrapping — preserves code, message
- [ ] No workspace → still works (backward compat)

---

## Phase 8: ForgeRuntime + Hot Updates (`@koi/forge`)

Wire workspace management into the runtime for cache invalidation and hot updates.

### 8.1 Update `forge-runtime.ts`
- [ ] Pass workspace path from resolve stage through to `brickToTool()`
- [ ] On store change event → invalidate workspace entry file (not the whole workspace)
- [ ] Re-forge workflow: detect dep change → new workspace (or reuse) → rewrite entry file → invalidate module cache (via new content hash)

### 8.2 Workspace cleanup on brick removal
- [ ] On `StoreChangeEvent.kind === "removed"` → mark workspace for cleanup if no other brick references the same dep hash
- [ ] Lazy cleanup — don't block the event handler

### 8.3 Update `forge-runtime.test.ts`
- [ ] Test workspace path propagation to brickToTool
- [ ] Test hot update: dep change → cache invalidation → fresh resolve

---

## Phase 9: Provenance Updates (`@koi/core`)

Record npm dependencies in SLSA provenance.

- [ ] `packages/core/src/provenance.ts` — Add npm deps to `ForgeBuildDefinition.resolvedDependencies` as `ForgeResourceRef[]`:
  ```typescript
  { uri: "pkg:npm/zod@3.24.0", name: "zod" }
  ```
- [ ] Update attestation serializer in `@koi/forge` to include dep refs
- [ ] Update `slsa-serializer.test.ts` with dep refs

---

## Phase 10: Validate Static Validation for `packages` field

### 10.1 Update `verify-static.ts`
- [ ] Add `validatePackages(packages: Record<string, string>)`:
  - Package name format validation (npm naming rules)
  - Version string format validation (exact semver only)
  - Max count check (against `config.dependencies.maxDependencies`)
- [ ] Call `validatePackages()` from `validateRequires()` when `packages` field present

### 10.2 Update `verify-static.test.ts`
- [ ] Tests for packages validation:
  - Valid packages → pass
  - Invalid package name → fail
  - Version range (not exact) → fail
  - Exceeds max count → fail
  - Empty packages → pass

---

## Phase 11: Export + Index Updates

- [ ] `packages/forge/src/index.ts` — Export new modules:
  - `workspace-manager.ts` (createBrickWorkspace, computeDependencyHash, cleanupStaleWorkspaces)
  - `dependency-audit.ts` (auditDependencies)
  - `verify-resolve.ts` (verifyResolve)
- [ ] `packages/core/src/index.ts` — Export `ExecutionContext`
- [ ] Update `@koi/core` API surface snapshot

---

## Phase 12: Verify

- [ ] Run `bun run build` — clean compilation across all packages
- [ ] Run `bun test` — all tests pass
- [ ] Run `bun run lint` — Biome passes
- [ ] Verify test coverage >= 80%
- [ ] Anti-leak: `@koi/core` has zero imports from other packages
- [ ] Anti-leak: L2 packages only import from L0 and L0u
- [ ] Anti-leak: No vendor types in L0 or L1
- [ ] All interface properties are `readonly`
- [ ] No `enum`, `any`, `as Type`, `!` assertions in new code
- [ ] ESM-only with `.js` extensions in all import paths
- [ ] No hardcoded secrets

---

## Files Summary

### New Files (~8 files)
| File | Package | LOC est. | Purpose |
|------|---------|----------|---------|
| `workspace-manager.ts` | @koi/forge | ~200 | Workspace creation, caching, cleanup |
| `workspace-manager.test.ts` | @koi/forge | ~200 | Unit tests (mocked I/O) |
| `dependency-audit.ts` | @koi/forge | ~100 | Allowlist/denylist validation |
| `dependency-audit.test.ts` | @koi/forge | ~150 | Adversarial tests |
| `verify-resolve.ts` | @koi/forge | ~100 | Pipeline stage: audit + install + pre-write |
| `verify-resolve.test.ts` | @koi/forge | ~150 | Stage tests |
| `brick-conversion.test.ts` | @koi/forge | ~100 | TDD for trust-tier dispatch |
| `workspace-integration.test.ts` | @koi/forge | ~80 | Integration tests (env-gated) |

### Modified Files (~12 files)
| File | Package | Changes |
|------|---------|---------|
| `brick-store.ts` | @koi/core | Add `packages` to `BrickRequires` |
| `sandbox-executor.ts` | @koi/core | Add `ExecutionContext` type + parameter |
| `provenance.ts` | @koi/core | Add npm dep refs to provenance |
| `types.ts` | @koi/forge | Extract `ForgeInputBase`, add `"resolve"` stage |
| `config.ts` | @koi/forge | Add `DependencyConfig` section |
| `verify.ts` | @koi/forge | Insert resolve stage into pipeline |
| `verify-static.ts` | @koi/forge | Add `validatePackages()` |
| `brick-conversion.ts` | @koi/forge | Trust-tier dispatch + workspace path |
| `forge-runtime.ts` | @koi/forge | Workspace path propagation, hot update |
| `promoted-executor.ts` | @koi/sandbox-executor | `import()` + LRU cache |
| `index.ts` | @koi/forge | Export new modules |
| `index.ts` | @koi/core | Export `ExecutionContext` |

### Estimated Total
- New code: ~1,080 LOC
- Modified code: ~300 LOC changes
- Tests: ~680 LOC (63% of new code is tests)
