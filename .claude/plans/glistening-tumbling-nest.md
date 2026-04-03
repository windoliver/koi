# Plan: Archive v1, Scaffold v2 (Issue #1179)

## Context

Koi has 245 workspace packages. The v2 rewrite retains only the kernel (L0 + L1) and 11 L0u utilities — 15 packages total. Everything else moves to `archive/v1/` for reference. The git tag `v1-archive` preserves full history.

## Retained Packages (15)

| Layer | Package | Path |
|-------|---------|------|
| L0 | @koi/core | packages/kernel/core |
| L1 | @koi/engine | packages/kernel/engine |
| L1 | @koi/engine-compose | packages/kernel/engine-compose |
| L1 | @koi/engine-reconcile | packages/kernel/engine-reconcile |
| L0u | @koi/errors | packages/lib/errors |
| L0u | @koi/event-delivery | packages/lib/event-delivery |
| L0u | @koi/execution-context | packages/lib/execution-context |
| L0u | @koi/file-resolution | packages/lib/file-resolution |
| L0u | @koi/hash | packages/lib/hash |
| L0u | @koi/session-repair | packages/mm/session-repair |
| L0u | @koi/token-estimator | packages/mm/token-estimator |
| L0u | @koi/validation | packages/lib/validation |
| L0u | @koi/edit-match | packages/lib/edit-match |
| L0u | @koi/git-utils | packages/lib/git-utils |
| L0u | @koi/shutdown | packages/lib/shutdown |

Remaining subsystems: `kernel`, `lib`, `mm` (3 of current 18).

## Step 1: Tag + Branch

- `git tag v1-archive` on current main
- Create branch `chore/v2-scaffold`

## Step 2: Move v1 Packages to `archive/v1/`

Use `git mv` preserving subsystem structure under `archive/v1/packages/`.

**Entire subsystems archived** (all packages move): deploy, drivers, forge, fs, ipc, meta, middleware, net, observability, sched, security, ui, virt, data-source, exec

**Partial subsystems** (move individual packages):
- kernel: archive `bootstrap`, `config`, `manifest`, `soul`
- lib: archive 20 packages (all except errors, event-delivery, execution-context, file-resolution, hash, validation, edit-match, git-utils, shutdown)
- mm: archive 14 packages (all except session-repair, token-estimator)

**Other workspaces**: archive `tests/e2e/` and `recipes/codex-mcp/`

**Scripts**: archive 46 `e2e-*.ts` files plus other v1-only scripts (`mock-acp-server.ts`, `pi-acp-server.ts`, `scaffold-middleware.ts`, `check-test-utils-migration.ts`, `generate-descriptor-manifest.ts`, `build-binary.ts`, etc.) to `archive/v1/scripts/`

Clean up empty subsystem dirs after moves.

## Step 3: Handle Engine Tests with Archived Deps

6 engine test files import archived packages:

| File | Archived imports | Action |
|------|-----------------|--------|
| `e2e-capability-cards.test.ts` | @koi/resolve | Move to archive |
| `e2e-scheduler.test.ts` | @koi/scheduler, @koi/scheduler-provider | Move to archive |
| `e2e-service-provider.test.ts` | @koi/filesystem, @koi/webhook-provider | Move to archive |
| `e2e-signal-cancellation-v2.test.ts` | @koi/middleware-sandbox | Move to archive |
| `inbox-integration.test.ts` | @koi/test-utils (createFakeEngineAdapter) | Inline helper |
| `registry.test.ts` | @koi/test-utils (runAgentRegistryContractTests) | Inline helper |

## Step 4: Update Configuration Files

All parallelizable (independent files):

### 4a. `package.json` (root)
- Remove `tests/e2e` and `recipes/*` from workspaces
- Remove scripts referencing archived packages: `build:cli`, `build:binary`, `build:binary:all`, `koi`, `tui`, `tui:init`, `scaffold:middleware`, `check:test-utils-migration`, `generate:descriptor-manifest`
- Add new scripts: `check:doc-gate`, `check:test-integrity`, `check:complexity`

### 4b. `tsconfig.json`
- Replace 71 references with 15 (retained packages only)

### 4c. `scripts/layers.ts`
- Reduce `L0U_PACKAGES` from 47 to 11
- Empty `L3_PACKAGES` and `L4_PACKAGES` sets

### 4d. `tests/structure/directory-structure.test.ts`
- `EXPECTED_SUBSYSTEMS` → `["kernel", "lib", "mm"]`
- Package count → 15

### 4e. `@koi/engine` package.json
- Remove all 20 devDependencies (all reference archived packages)

### 4f. `@koi/validation` and `@koi/edit-match` package.json
- Remove `@koi/test-utils` from devDependencies

### 4g. `scripts/check-descriptions.ts`
- Remove `tests/e2e/package.json` path
- Remove `recipes/*/package.json` glob scan

### 4h. `knip.ts`
- Remove `tests/e2e` and `recipes/*` workspace configs

### 4i. `.jscpd.json`
- Add `archive/**` to ignore list

### 4j. `biome.json`
- Remove override for archived `packages/virt/sandbox-ipc/src/worker-source.ts`

### 4k. `CLAUDE.md`
- Update L0u list (47 → 11 packages)
- Update L3 note (currently empty)

### 4l. Regenerate derived files
- Run `bun scripts/generate-layer-docs.ts` to update `.github/labeler.yml` and `docs/architecture/Koi.md`

## Step 5: Create New Files

### 5a. `CHANGELOG.md`
v2 changelog documenting the archive and retained packages.

### 5b. `scripts/check-doc-gate.ts`
CI gate: every active L2 package must have `docs/L2/<name>.md`. Currently passes vacuously (zero L2 packages). Ready for Phase 1+ development.

### 5c. `scripts/check-test-integrity.ts`
CI guard: detects test file deletions and test count decreases in PRs. Uses `git diff --stat origin/main`. Escape hatch: `[test-archive]` in commit message for this initial PR.

### 5d. `scripts/check-complexity.ts`
CI guard: files > 400 lines or functions > 50 lines are violations. Scans `packages/*/*/src/**/*.ts` excluding test files.

### 5e. Update `.github/workflows/ci.yml`
Add steps: `check:doc-gate`, `check:complexity`, and `check:test-integrity` (PR-only).

## Step 6: Lockfile + Verification

Sequential:
1. `bun install` — regenerate lockfile for 15-package workspace
2. `bun run build`
3. `bun run typecheck`
4. `bun run check` (biome lint)
5. `bun run check:layers`
6. `bun run check:doc-sync`
7. `bun run check:descriptions`
8. `bun run test` — all 15 packages
9. `bun run check:doc-gate`
10. `bun run check:complexity`
11. `bun test tests/structure/directory-structure.test.ts`

## Commit Strategy

1. `chore: tag v1-archive` — git tag only
2. `chore: archive v1 packages` — all `git mv` operations + engine test archival
3. `chore: update configs for v2 scaffold` — all config file updates + inline engine test helpers
4. `feat: add v2 CI guards` — new scripts, CHANGELOG.md, ci.yml updates
5. `chore: regenerate lockfile` — `bun install` result

## Key Risks

| Risk | Mitigation |
|------|-----------|
| Engine tests break (archived devDeps) | Archive 4 e2e tests, inline 2 test-utils helpers |
| `bun install` fails (dangling workspace:* refs) | Grep all retained package.json for archived refs before install |
| `check-descriptions.ts` fails (missing tests/e2e/package.json) | Remove that path from script |
| `check-doc-sync` fails (stale labeler.yml) | Regenerate after layers.ts update |
